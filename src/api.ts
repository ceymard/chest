import Docker, { Container, ContainerInspectInfo } from "dockerode"
import path from "path"
import ch from "chalk"
import * as os from "os"
import * as fs from "fs"
import * as helpers from "./helper"
import Dockerode from "dockerode"
import * as toml from "smol-toml"
import * as s from "@salesway/scotty"

export const docker = new Docker()
const STAR = ch.greenBright(" *")

const current_user = os.userInfo({encoding: "utf-8"})

function log_value<T, K extends keyof T>(opts: T, name: K) {
  if (opts[name]) {
    const value = opts[name]
    console.log(` ${ch.bold.cyanBright("=")} ${ch.cyan(name)}: ${ch.magentaBright(Array.isArray(value) ? "\n  " + value.join(",\n  ") : value)}`)
  }
}

export function command_tag(tpl: TemplateStringsArray, ...values: string[]) {
  const res: string[] = []
  for (let i = 0; i < tpl.length; i++) {
    res.push(tpl[i])
    if (values[i]) res.push(values[i])
  }
  return res.join("")
}

/** The config class to get some defaults. */
export class ChestConfig {

  @s.str user = current_user.username
  @s.str backups_root_dir: string = path.join(current_user.homedir, "backups")
  @s.str passphrase?: string
  @s.str prune = "--keep-daily 7 --keep-weekly 2 --keep-monthly 1"
  @s.str borg_image = "ceymard/borg:1.2.8"

  archive = ""
  keep_running = false
  repository = "!repository-was-not-set"
  prefix = ""

  clone(): this {
    return Object.assign(new ChestConfig(), this)
  }
}


/** */
export function read_config() {
  const home = os.homedir()
  const files = [
    `${home}/.config/chest/chest.toml`,
    `${home}/.chest.toml`,
    `/etc/chest.toml`
  ]
  const ser = s.Serializer.get(ChestConfig)
  const config = new ChestConfig()

  for (let name of files) {
    try {
      const cts = toml.parse(fs.readFileSync(name, "utf-8"))
      ser.deserialize(cts, config)
      break
    } catch (e) {

    }
  }

  return config
}

read_config()


export function get_archive_name(infos: RunBorgOnContainerOptions) {
  return (infos.config.prefix || infos.infos?.Id || "chest") + "-" + helpers.getTimestamp()
}


/** If not provided by the command, fill default optoins */
export function fill_defaults_from_container(infos: ContainerInspectInfo, config: ChestConfig) {

  const labels = infos.Config.Labels

  const backups_root_dir = process.env.CHEST_BACKUPS_DIR
    ?? labels["chest.backups_root_dir"]
    ?? config.backups_root_dir

  const passphrase = process.env.BORG_PASSPHRASE
    ?? labels["chest.passphrase"]
    ?? labels["borg.passphrase"]
    ?? config.passphrase

  const prune = process.env.BORG_PRUNE
    ?? labels["borg.prune"]
    config.prune

  const repository = process.env.BORG_REPOSITORY
    ?? labels["borg.repository"]
    ?? labels["chest.repository"]
    ?? path.join(config.backups_root_dir, labels["chest.name"] ?? labels["com.docker.compose.project"])

  const prefix = process.env.CHEST_PREFIX
    ?? labels["chest.prefix"]
    ?? labels["com.docker.compose.service"]

  const archive = process.env.CHEST_ARCHIVE
    ?? `${prefix}-${helpers.getTimestamp()}`

  if (!repository) {
    throw new Error(`no valid repository (${repository})`)
  }

  return {
    backups_root_dir,
    passphrase,
    prune,
    repository,
    prefix,
    archive,
  }

}


export interface RunBorgOptions {
  /** a repository, can be over SSH */
  repository: string

  env?: {[name: string]: string}

  /** docker binds */
  binds?: string[]

  passphrase?: string

  /** */
  stdout?: (data: any, id: number) => any,
  stderr?: (data: any, id: number) => any,

  config: ChestConfig
}

export interface Command {
  command: string
}

/**
 * set up the borg container and run the command in it
 * we suppose that we have already inspected a container's volumes and that they're in the binds before running this function
 * */
export async function run_borg_backup(args: RunBorgOptions & Command) {

  log_value(args, "repository")
  log_value(args, "binds")

  // We're not going to do to the same thing
  const repo_is_ssh = args.repository.includes("@")

  // Default borg options that we use
  const env = Object.assign({
    BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK: "yes",
    BORG_RELOCATED_REPO_ACCESS_IS_OK: "yes",
    BORG_HOSTNAME_IS_UNIQUE: "no",
    BORG_REPO: repo_is_ssh ? args.repository : "/repository"
  }, args.env)

  if (args.passphrase) {
    env.BORG_PASSPHRASE = args.passphrase
  }

  // A series of default binds
  const binds = (args.binds??[]).slice()
  binds.push(
    "/etc/hosts:/etc/hosts:ro",
    "/etc/localtime:/etc/localtime:ro",
    "/etc/timezone:/etc/timezone:ro",
    "/etc/passwd:/etc/passwd:ro",
    "/etc/group:/etc/group:ro",
  )

  let command = args.command

  // Set up the repository
  if (repo_is_ssh) {
    if (process.env.SSH_AUTH_SOCK) {
      // add the ssh agent socket to the container as well as the env variable
      binds.push(`${process.env.SSH_AUTH_SOCK}:${process.env.SSH_AUTH_SOCK}`)
      env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK

      // mount the current user's .ssh directory to /ssh in the container
      binds.push(`${os.homedir()}/.ssh:/ssh:ro`)

      // and copy them before running the original command
      command = `
      mkdir /root/.ssh ; cp -Rf /ssh/* /root/.ssh/
      ${command}
      `
    }
  } else {
    // If not ssh, just bind the repository
    binds.push(`${args.repository}:/repository:rw`)
  }

  const borg = await docker.createContainer({
    Image: args.config.borg_image,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: binds
    },
    WorkingDir: "/data",
    Entrypoint: "/bin/ash",
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    Cmd: ['-c', command]
  })

  try {
    containers_to_stop_and_delete.add(borg.id)
    await borg.start();

    const stream = await borg.logs({stdout: true, stderr: true, follow: true})

    const stdout = helpers.jsonStream(args.stdout)
    const stderr = helpers.jsonStream((data, key) => {
      if (
        data.type !== "question_prompt"
        && data.type !== "question_env_answer"
      ) {
        if (data.type === "log_message") {
          if (data.levelname === "ERROR" && data.msgid !== "Repository.AlreadyExists") {
            console.error(ch.redBright(" ⚠"), data.message)
          } else if (data.levelname === "WARNING") {
            console.error(ch.yellowBright(" ⚠"), data.message)
          }
        }
        args.stderr?.(data, key)
        // console.error(value)
      }
    })

    // Attach a json stream reader
    borg.modem.demuxStream(stream, stdout, stderr) //*/

    await borg.wait()

  } finally {
    await container_stop(borg)
    await borg.remove({  })
  }

}


export interface RunBorgOnContainerOptions extends RunBorgOptions {
  /** keep the container running if it was started. */
  keep_running?: boolean

  container: Dockerode.Container
  infos: Dockerode.ContainerInspectInfo
}


/** */
export async function run_borg_backup_on_container(args: RunBorgOnContainerOptions & Command) {

  args.binds ??= []

  args.binds.push(
    ...args.infos.Mounts.map(m => `${m.Source}:${path.join(`/data`, m.Destination)}:rw`)
  )

  const labels = args.infos.Config.Labels

  // const compose_working_dir = labels["com.docker.compose.project.working_dir"]
  const compose_config_files = labels["com.docker.compose.project.config_files"]
  if (compose_config_files) {
    args.binds.push(
      ...compose_config_files.split(/,/g).map(c => `${c}:/data/${path.basename(c)}:ro`)
    )
  }

  const should_stop_and_restart = !args.keep_running && !!args.infos.State.Running

  log_value(args, "keep_running")

  if (should_stop_and_restart) {
    containers_to_restart.add(args.container.id)
    await container_stop(args.container)
  }

  try {
    // Launch borg
    await run_borg_backup(args)
  } finally {
    // Restart the container if it was stopped
    if (containers_to_restart.has(args.container.id)) {
      await container_start(args.container)
      containers_to_restart.delete(args.container.id)
    }
  }

}


export interface DoRestoreOptions extends RunBorgOnContainerOptions {
  archive: string
}


/**
 * Restore a given container to the given archive
 */
export async function do_restore(opts: DoRestoreOptions) {
  if (opts.infos.State.Running) {
    console.error(ch.redBright("please shutdown the container and its whole stack before restoring to avoid inconsistencies and corrupted backups"))
    return
  }

  await run_borg_backup_on_container({
    ...opts,
    command: `cd /data && borg extract --progress --log-json --list -e '*.yml' -v "::${opts.archive}"`,
    stdout(data, id) {
      console.log(data)
    },
    stderr: helpers.stderr_progress,
  })
}

// export async function getContainerDescription(input: string) {

//   const container = await docker.getContainer(input.replace(/\.docker$/, ""))
//     const infos = await container.inspect()
//     const labels = infos.Config.Labels ?? {}
//     const binds = infos.Mounts.map(m => `${m.Source}:${path.join(`/data`, m.Destination)}:rw`)

//     const chest: RuntimeInfos["chest"] = {
//       name: labels["chest.name"] ?? labels["com.docker.compose.project"],
//       prefix: labels["chest.prefix"] ?? labels["com.docker.compose.service"] ?? process.env["CHEST_PREFIX"],
//       prune: labels["borg.prune"] ?? process.env["BORG_PRUNE"],
//       passphrase: labels["borg.passphrase"] ?? labels["chest.passphrase"] ?? process.env["CHEST_PASSPHRASE"] ?? process.env["BORG_PASSPHRASE"],
//       keep_running: !!labels["chest.keep-running"] || !!process.env["CHEST_KEEP_RUNNING"],
//       repository: labels["chest.repository"] ?? process.env["CHEST_REPOSITORY"],
//     }

//     const compose: RuntimeInfos["compose"] = {
//       workding_dir: labels["com.docker.compose.project.working_dir"],
//       config_files: labels["com.docker.compose.project.config_files"]?.split(/,/g)
//     }

//     const result: RuntimeInfos = {container, infos, labels, binds, chest, compose}

//     return result
// }


export interface DoBackupOptions extends RunBorgOnContainerOptions {
  archive: string
  prefix: string
  user: string
  group: string
}

export async function do_backup(opts: DoBackupOptions) {

  log_value(opts, "archive")
  log_value(opts, "prefix")

  // Do a warning if we're over SSH
  const is_ssh = opts.repository?.includes("@")
  if (is_ssh) {
    console.error(ch.bold.redBright(` ⚠⚠⚠ warning : you are about to backup to a remote server. This is dangerous, you may be inadvertently trying to backup to an existing backup.\n`))
    const continue_ = await helpers.question("Continue ? y/n")
    if (continue_.toLowerCase() !== "y") {
      console.error("aborting.")
      return
    }
  }

  let prune = process.env.CHEST_PRUNE
    ?? opts.infos.Config.Labels["borg.prune"]
    ?? opts.infos.Config.Labels["chest.prune"]
    ?? opts.config.prune

  if (prune === 'auto') {
    // Some usable defaults
    prune = '--keep-daily 7 --keep-weekly 2 --keep-monthly 1'
  } else if (prune && !prune.includes('-')) {
    // no real arguments to prune
    prune = ''
  }

  log_value({prune}, "prune")

  await run_borg_backup_on_container({
    ...opts,
    command: command_tag`
#if grep repository /repository/config > /dev/null 2>&1 ; [ "$?" -ne 0 ]; then
  borg init --log-json -e ${opts.passphrase ? "repokey-blake2" : "none"} ${is_ssh ? opts.repository : "/repository"}
#fi
cd /data && borg create --progress --json --log-json --stats "::${opts.archive}" ./*
${prune ? `
borg prune ${prune} --log-json -P "${opts.prefix}" -s --list ::` : ''}
chown -R ${opts.user}:${opts.user} /repository
`,
    stdout(out, id) {
      console.log(STAR, `duration ${ch.greenBright(Math.round(100 * out.archive.duration)/100)}s`)
      console.log(STAR, `deduplicated size ${ch.greenBright(helpers.formatBytes(out.archive.stats.deduplicated_size))}, uncompressed ${ch.redBright(helpers.formatBytes(out.archive.stats.original_size))}`)
      console.log(STAR, `repository size ${ch.greenBright(helpers.formatBytes(out.cache.stats.unique_csize))}`)
      console.log(ch.greenBright("->"), ch.bold.magentaBright(out.archive.name))
    },
    stderr: helpers.stderr_progress,
  })
}


/** Stop a container "properly ?" */
export async function container_stop(container: Docker.Container) {
  do {
    // should I kill it at some point ?
    const infos = await container.inspect()
    if (infos.State.Running) {
      console.log(ch.redBright(" ⏹︎ ") + " stopping " + ch.redBright(infos.Name))
      await container.stop({  })
    } else {
      break
    }
  } while (true)
}


export async function container_start(container: Docker.Container) {
  const infos = await container.inspect()
  if (!infos.State.Running) {
    console.log(ch.greenBright(" ⏹︎ ") + " starting " + ch.greenBright(infos.Name))
    container.start()
  }
}

const containers_to_restart = new Set<string>()
const containers_to_stop_and_delete = new Set<string>()

process.on("uncaughtException", async function (err) {
  for (let c of containers_to_restart) {
    await container_start(docker.getContainer(c))
  }
  for (let c of containers_to_stop_and_delete) {
    await container_stop(docker.getContainer(c))
  }
  console.error(err)
})
