import Docker, { Container, ContainerInspectInfo } from "dockerode"
import path from "path"
import ch from "chalk"
import * as es from "event-stream"
import * as os from "os"
import * as fs from "fs"
import * as helpers from "./helper"
import parser from "stream-json"
import StreamValues from "stream-json/streamers/StreamValues"
import Dockerode from "dockerode"
import * as toml from "smol-toml"
import * as s from "@salesway/scotty"

export const docker = new Docker()
const BORG_IMAGE = 'ceymard/borg:1.2.8'
const STAR = ch.greenBright(" *")

let cleanup: null | (() => any) = null

const current_user = os.userInfo({encoding: "utf-8"})

export class ChestConfig {

  @s.str user = current_user.username
  @s.str backups_root_dir: string = path.join(current_user.homedir, "backups")
  @s.str passphrase?: string
}


const config = new ChestConfig()

/** */
export function read_config() {
  const home = os.homedir()
  const files = [
    `${home}/.config/chest/chest.toml`,
    `${home}/.chest.toml`,
    `/etc/chest.toml`
  ]
  const ser = s.Serializer.get(ChestConfig)

  for (let name of files) {
    try {
      const cts = toml.parse(fs.readFileSync(name, "utf-8"))
      ser.deserialize(cts, config)
      break
    } catch (e) {

    }
  }
}

read_config()


export interface RuntimeInfos {
  container?: Container
  infos?: ContainerInspectInfo
  labels?: {
    [label: string]: string;
  }
  /** the binds that we'll need afterward */
  binds: string[]

  chest: {
    archive?: string
    backups_dir?: string
    name?: string
    prefix?: string
    repository?: string
    prune?: string
    auto?: boolean
    passphrase?: string
    keep_running?: boolean
    auto_backup?: boolean
    uid?: number
    gid?: number
  }

  compose: {
    workding_dir?: string
    config_files?: string[]
  }

}

/**
 * A simple timestamping function that returns string like '181101-030024'.
 *
 * We use this format because selecting it in a terminal won't choke, whereas
 * using a regular date time format tends to not select text past the ':'
 */
export function getTimestamp() {
  var d = new Date()
  var pad = (n: number) => n < 10 ? '0' + n : n.toString()
  return d.getFullYear().toString().slice(2, 4)
    + pad(d.getMonth() + 1)
    + pad(d.getDate())
    + '-'
    + pad(d.getHours())
    + pad(d.getMinutes())
    + pad(d.getSeconds())
}


export interface RunBorgOptions {
  /** a repository, can be over SSH */
  repository: string

  command: string

  env?: {[name: string]: string}

  /** docker binds */
  binds: string[]

  passphrase?: string

  /** */
  stdout?: (data: any, id: number) => any,
  stderr?: (data: any, id: number) => any,
}


/**
 * set up the borg container and run the command in it
 * we suppose that we have already inspected a container's volumes and that they're in the binds before running this function
 * */
export async function run_borg_backup(args: RunBorgOptions) {

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
  const binds = args.binds.slice()
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
    Image: BORG_IMAGE,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: binds
    },
    WorkingDir: '/data',
    Entrypoint: '/bin/ash',
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    Cmd: ['-c', command]
  })

  containers_to_stop_and_delete.add(borg.id)
  await borg.start();
  const stream = await borg.logs({stdout: true, stderr: true, follow: true})

  // Attach a json stream reader
  borg.modem.demuxStream(stream, helpers.jsonStream(args.stdout), helpers.jsonStream(data => {
    const value = data.value
    if (
      value.type !== "question_prompt"
      && value.type !== "question_env_answer"
    ) {
      if (value.type === "log_message") {
        if (value.levelname === "ERROR" && value.msgid !== "Repository.AlreadyExists") {
          console.error(ch.redBright(" ⚠"), value.message)
        } else if (value.levelname === "WARNING") {
          console.error(ch.yellowBright(" ⚠"), value.message)
        }
      }
      args.stderr?.(value, data.key)
      // console.error(value)
    }
  }))

  await borg.stop()
  await borg.remove({  })
  // FIXME need to chown once we're done !
  // if (cont.chest.uid && !repo_is_ssh) {
  //   command += `\nchown -R ${cont.chest.uid}:${cont.chest.gid} /repository/*\n`
  // }
}


export interface RunBorgOnContainerOptions extends RunBorgOptions {
  /** keep the container running if it was started. */
  keep_running?: boolean

  container: Dockerode.Container
  infos: Dockerode.ContainerInspectInfo
}


/** */
export async function run_borg_backup_on_container(args: RunBorgOnContainerOptions) {

  const binds = args.binds
  const labels = args.infos.Config.Labels

  // const compose_working_dir = labels["com.docker.compose.project.working_dir"]
  const compose_config_files = labels["com.docker.compose.project.config_files"]
  if (compose_config_files) {
    binds.push(
      ...compose_config_files.split(/,/g).map(c => `${c}:/data/${path.basename(c)}:ro`)
    )
  }

  const should_stop_and_restart = !args.keep_running && !!args.infos.State.Running

  if (should_stop_and_restart) {
    containers_to_restart.add(args.container.id)
    await stopContainer(args.container)
  }

  try {
    // Launch borg
    await run_borg_backup(args)
  } finally {
    // Restart the container if it was stopped
    if (containers_to_restart.has(args.container.id)) {
      await startContainer(args.container)
      containers_to_restart.delete(args.container.id)
    }
  }

}


/**
 * Run the given command in the container.
 * @param cont the container
 * @param repo the directory of the repository
 */
export async function runBorg(
  cont: RuntimeInfos,
  args: string,
  stdout?: (data: any, id: number) => any,
  stderr?: (data: any, id: number) => any,
) {


  if (!cont.chest.repository) {
    throw new Error("no repository")
  }

  const infos = cont.infos
  const container_was_running = !!infos?.State.Running
  const labels = cont.labels

  const repository = cont.chest.repository
  const repo_is_ssh = repository.includes("@")

  // Get the volumes of our container and mount them in /data
  const binds: string[] = cont.binds

  // A series of basic binds that we need
  binds.push('/etc/hosts:/etc/hosts:ro')
  binds.push('/etc/localtime:/etc/localtime:ro')
  binds.push('/etc/timezone:/etc/timezone:ro')

  // binds.push(`${process.cwd()}:/cwd:rw`)

  // A few environment variables needed for chest to work
  const env = [
    "BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=yes",
    "BORG_RELOCATED_REPO_ACCESS_IS_OK=yes",
    "BORG_HOSTNAME_IS_UNIQUE=no",
    `BORG_REPO=${repo_is_ssh ? repository : "/repository"}`,
  ]

  if (!repo_is_ssh) {
    binds.push(`${cont.chest.repository}:/repository:rw`)
  } else if (process.env["SSH_AUTH_SOCK"]) {

    binds.push(`${process.env["SSH_AUTH_SOCK"]}:${process.env["SSH_AUTH_SOCK"]}`)
    binds.push(`${os.homedir()}/.ssh:/ssh:ro`)
    env.push(`SSH_AUTH_SOCK=${process.env["SSH_AUTH_SOCK"]}`)
    args = `
    mkdir /root/.ssh ; cp -Rf /ssh/* /root/.ssh/
    ${args}
    `
  }

  const passphrase = process.env.BORG_PASSPHRASE || labels?.['borg.passphrase'] || ''
  if (passphrase) {
    env.push(`BORG_PASSPHRASE=${passphrase}`)
  }

  let shutdown_container = false
  if (!cont.chest.keep_running) {
    shutdown_container = true
  }

  // Add docker-compose.yml to the back-ups if the container is part of a compose file
  if (cont.compose.config_files) {
    binds.push(
      ...cont.compose.config_files.map(c => `${c}:/data/${path.basename(c)}:ro`)
    )
  }

  let borg: Docker.Container | undefined

  const try_stop = async (container: Docker.Container) => {
    const running = (await container.inspect()).State.Running
    if (running)
      await container.stop({  })
    return running
  }

  if (cont.chest.uid && !repo_is_ssh) {
    args += `\nchown -R ${cont.chest.uid}:${cont.chest.gid} /repository/*\n`
  }

  try {

    if (cont && cont.container && infos && infos.State.Running && shutdown_container) {
      console.log(` ${ch.redBright("⏸︎")} stopping ${infos.Name}`)
      await try_stop(cont.container)
      // Let's give ourselves some time.
      await new Promise(ac => setTimeout(ac, 1000))
    }

    cleanup = async () => {
      if (borg) await try_stop(borg)

      // Restart container if it was running before
      try {
        if (cont && cont.container && infos && shutdown_container && container_was_running && !(await cont.container.inspect()).State.Running) {
          console.log(` ${ch.greenBright("⏵︎")} restarting ${infos.Name}`)
          await cont.container.start()
        }
      } catch { }
      if (borg)
        await borg.remove()
    }

    borg = await docker.createContainer({
      Image: BORG_IMAGE,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: binds
      },
      WorkingDir: '/data',
      Entrypoint: '/bin/ash',
      Env: env,
      Cmd: ['-c', args]
    })

    await borg.start();
    const stream = await borg.logs({stdout: true, stderr: true, follow: true})


    const _stdout2 = es.pipeline(
      parser({ jsonStreaming: true }),
      new StreamValues(),
      es.mapSync((data: any) => {
        stdout?.(data.value, data.key)
        return data
      })
    )

    const _stderr2 = es.pipeline(
      parser({ jsonStreaming: true }),
      new StreamValues(),
      es.mapSync((data: any) => {
        const value = data.value
        if (
          value.type !== "question_prompt"
        && value.type !== "question_env_answer"
      ) {
          if (value.type === "log_message") {
            if (value.levelname === "ERROR" && value.msgid !== "Repository.AlreadyExists") {
              console.error(ch.redBright(" ⚠"), value.message)
            } else if (value.levelname === "WARNING") {
              console.error(ch.yellowBright(" ⚠"), value.message)
            }
          }
          stderr?.(value, data.key)
          // console.error(value)
        }

        return data
      })
    )

    borg.modem.demuxStream(stream, _stdout2, _stderr2)
    // borg.modem.demuxStream(stream, process.stdout, process.stderr)

    await borg.wait()
    await try_stop(borg)
  } finally {
    // Stop borg if it is still running but errored
    await cleanup?.()
    cleanup = null
  }

}


export async function getContainerDescription(input: string) {

  const container = await docker.getContainer(input.replace(/\.docker$/, ""))
    const infos = await container.inspect()
    const labels = infos.Config.Labels ?? {}
    const binds = infos.Mounts.map(m => `${m.Source}:${path.join(`/data`, m.Destination)}:rw`)

    const chest: RuntimeInfos["chest"] = {
      name: labels["chest.name"] ?? labels["com.docker.compose.project"],
      prefix: labels["chest.prefix"] ?? labels["com.docker.compose.service"] ?? process.env["CHEST_PREFIX"],
      prune: labels["borg.prune"] ?? process.env["BORG_PRUNE"],
      passphrase: labels["borg.passphrase"] ?? labels["chest.passphrase"] ?? process.env["CHEST_PASSPHRASE"] ?? process.env["BORG_PASSPHRASE"],
      keep_running: !!labels["chest.keep-running"] || !!process.env["CHEST_KEEP_RUNNING"],
      repository: labels["chest.repository"] ?? process.env["CHEST_REPOSITORY"],
    }

    const compose: RuntimeInfos["compose"] = {
      workding_dir: labels["com.docker.compose.project.working_dir"],
      config_files: labels["com.docker.compose.project.config_files"]?.split(/,/g)
    }

    const result: RuntimeInfos = {container, infos, labels, binds, chest, compose}

    return result
}


export async function performBackup(cont: RuntimeInfos) {
  const is_ssh = cont.chest.repository?.includes("@")

  if (is_ssh) {
    console.error(ch.bold.redBright(` ⚠⚠⚠ warning : you are about to backup to a remote server. This is dangerous, you may be inadvertently trying to backup to an existing backup.\n`))
    const continue_ = await helpers.question("Continue ? y/n")
    if (continue_.toLowerCase() !== "y") {
      console.error("aborting.")
      return
    }
  }

  if (!is_ssh) {
    helpers.ensure_valid_repository(cont.chest.repository!)
  }

  cont.chest.uid = process.getuid?.()
  cont.chest.gid = process.getgid?.()

  let prune = cont.chest.prune
  if (prune === 'auto') {
    prune = '--keep-daily 7 --keep-weekly 2 --keep-monthly 1'
  } else if (prune && !prune.includes('-')) {// no real arguments to prune
    prune = ''
  }

  const is_tty = process.stderr.hasColors()

  // FIXME should prune on prefix only !
  await runBorg(cont, `
    #if grep repository /repository/config > /dev/null 2>&1 ; [ "$?" -ne 0 ]; then
      borg init --log-json -e ${cont.chest.passphrase ? "repokey-blake2" : "none"} ${is_ssh ? cont.chest.repository : "/repository"}
    #fi
    cd /data && borg create --progress --json --log-json --stats "::${cont.chest.archive}" ./*
    ${prune ? `
    # borg prune ${prune} --log-json -P "${cont.chest.prefix}" -s --list ::` : ''}
  `, (out) => {

    // console.log(out)
    console.log(STAR, `duration ${ch.greenBright(Math.round(100 * out.archive.duration)/100)}s`)
    console.log(STAR, `deduplicated size ${ch.greenBright(helpers.formatBytes(out.archive.stats.deduplicated_size))}, uncompressed ${ch.redBright(helpers.formatBytes(out.archive.stats.original_size))}`)
    console.log(STAR, `repository size ${ch.greenBright(helpers.formatBytes(out.cache.stats.unique_csize))}`)
    console.log(ch.greenBright("->"), ch.bold.magentaBright(out.archive.name))
  }, !is_tty ? undefined : err => {
    if (err.type === "progress_percent" || err.type === "progress_message") {
      process.stderr.clearLine(0)
      process.stderr.cursorTo(0)
      if (!err.finished) {
        process.stderr.write(err.message)
      }
    }
  })
}


/** Stop a container "properly ?" */
export async function stopContainer(container: Docker.Container) {
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


export async function startContainer(container: Docker.Container) {
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
    await startContainer(docker.getContainer(c))
  }
  for (let c of containers_to_stop_and_delete) {
    await stopContainer(docker.getContainer(c))
  }
  console.error(err)
  cleanup?.()
})
