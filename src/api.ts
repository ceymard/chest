import Docker, { ContainerInfo, ContainerInspectInfo } from "dockerode"
const { Container } = Docker
import path from "path"

import ch from "chalk"
import * as os from "os"
import * as fs from "fs"
import * as helpers from "./helper.js"
import Dockerode from "dockerode"
import * as toml from "smol-toml"
import * as s from "@salesway/scotty"

export const docker = new Docker()
const STAR = ch.greenBright(" *")

const current_user = os.userInfo({encoding: "utf-8"})

function log_value<T, K extends keyof T>(opts: T, name: K) {
  if (opts[name]) {
    const value = opts[name]
    console.log(` ${ch.bold.cyanBright("=")} ${ch.cyan(name)}: ${ch.magentaBright(Array.isArray(value) ? "\n  " + value.map((v: string) => v.replace(/:([^:]+)/, (_, a) => ":" + ch.yellowBright(a))).join(",\n  ") : value)}`)
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
  @s.str group = ""+current_user.gid

  @s.str backups_root_dir: string = path.join(current_user.homedir, "backups")
  @s.str backups_compose_dir = this.backups_root_dir
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


export function merge_labels(containers: ContainerInfo[]): { [label: string]: string; } {
  const res = {}
  for (let c of containers) {
    Object.assign(res, c.Labels)
  }
  return res
}


/** If not provided by the command, fill default optoins */
export function fill_defaults_from_container(infos: ContainerInspectInfo | ContainerInfo[], config: ChestConfig) {

  const labels = Array.isArray(infos) ? merge_labels(infos) : infos.Config.Labels

  const backups_root_dir = process.env.CHEST_BACKUPS_DIR
    ?? labels["chest.backups_root_dir"]
    ?? config.backups_root_dir

  const backups_compose_dir = process.env.CHEST_BACKUPS_COMPOSE_DIR
    ?? labels["chest.backups_compose_dir"]
    ?? config.backups_compose_dir


  const passphrase = process.env.BORG_PASSPHRASE
    ?? labels["chest.passphrase"]
    ?? labels["borg.passphrase"]
    ?? config.passphrase

  let prune = process.env.CHEST_PRUNE
    // ?? labels["borg.prune"]
    // ?? labels["chest.prune"]
    ?? config.prune

  if (prune === 'auto') {
    // Some usable defaults
    prune = '--keep-daily 7 --keep-weekly 2 --keep-monthly 1'
  } else if (prune && !prune.includes('-')) {
    // no real arguments to prune
    prune = ''
  }

  const repository = process.env.BORG_REPOSITORY
    ?? labels["borg.repository"]
    ?? labels["chest.repository"]
    ?? path.join(config.backups_root_dir, /*labels["chest.name"] ??*/ labels["com.docker.compose.project"])

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
    backups_compose_dir,
    passphrase,
    prune,
    repository,
    prefix,
    archive,
  }

}


export interface RunBorgOptions {
  /** a repository, can be over SSH */
  repository?: string

  env?: {[name: string]: string}

  /** docker binds */
  binds?: string[]

  passphrase?: string
  no_json?: boolean

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

  // We're not going to do to the same thing
  const repo_is_ssh = args.repository?.includes("@")

  // Default borg options that we use
  const env = Object.assign({
    BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK: "yes",
    BORG_RELOCATED_REPO_ACCESS_IS_OK: "yes",
    BORG_HOSTNAME_IS_UNIQUE: "no",
  }, args.env)

  if (args.repository) {
    env.BORG_REPO = repo_is_ssh ? args.repository : "/repository"
  }

  if (args.passphrase) {
    env.BORG_PASSPHRASE = args.passphrase
    if (!args.repository) {
      console.error(ch.yellowBright(" ! ") + "a passphrase was supplied but there is no borg repository")
    }
  }

  // A series of default binds
  const binds = args.binds??[]
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
    }

    // mount the current user's .ssh directory to /ssh in the container
    binds.push(`${os.homedir()}/.ssh:/ssh:ro`)

    // and copy them before running the original command
    command = `
    mkdir /root/.ssh ; cp -Rf /ssh/* /root/.ssh/
    ${command}
    `

  } else if (args.repository) {
    // If not ssh, just bind the repository
    binds.push(`${args.repository}:/repository:rw`)
  }

  log_value(args, "binds")


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

    if (process.env.CHEST_DEBUG || args.no_json) {
      borg.modem.demuxStream(stream, process.stdout, process.stderr) //*/
    } else {
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
    }

    await borg.wait()

  } finally {
    await container_stop(borg)
    containers_to_stop_and_delete.delete(borg.id)
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


export interface DoBackupOptions extends RunBorgOnContainerOptions {
  repository: string
  archive: string
  prefix: string
  user: string
  group: string
  prune: string
}


/** Perform a backup of a single container */
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

  const prune = opts.prune
  log_value({prune}, "prune")

  await run_borg_backup_on_container({
    ...opts,
    command: command_tag`
borg init --log-json -e ${opts.passphrase ? "repokey-blake2" : "none"} ${is_ssh ? opts.repository : "/repository"}
cd /data && borg create --progress --json --log-json --stats "::${opts.archive}" ./*
${prune ? `
borg prune ${prune} --log-json -P "${opts.prefix}" -s --list ::` : ''}
chown -R ${opts.user}:${opts.group} /repository
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




export interface RunBorgOnProjectOptions extends RunBorgOptions {
  project_name: string
  containers?: ContainerInfo[]
  keep_running?: boolean
  leave_wd?: boolean
}


type FigureOutItem = {
  info: ContainerInspectInfo,
  provides: Set<string>,
  needs: Set<string>,
  running: boolean
}

// "com.docker.compose.depends_on": "postgres:service_started:true"
function figure_out_container_deps(containers: ContainerInspectInfo[]) {

  let items = [] as FigureOutItem[]

  for (let c of containers) {
    const provides = new Set([c.Name, c.Config.Labels["com.docker.compose.service"]])

    const depends_on = c.Config.Labels["com.docker.compose.depends_on"] ?? ""
    const needs = new Set(depends_on.trim().length === 0 ? []
      : depends_on.split(/,/g).map(dep => dep.split(":")[0]))

    const links = c.HostConfig.Links as string[]
    if (links) {
      for (let link of links) {
        const contneed = link.split(":")[0]
        needs.add(contneed)
      }
    }
    // for (c.HostConfig.Links)

    items.push({
      info: c,
      needs,
      provides,
      running: !!c.State.Running,
    })
  }

  const mp = new Map<string, FigureOutItem>()
  for (let it of items) {
    for (let prov of it.provides) {
      mp.set(prov, it)
    }
  }

  const res = new Set(items)

  function _need(i: FigureOutItem, needs: string) {
    i.needs.add(needs)
    const c = mp.get(needs)
    if (c) {
      res.delete(c)
      res.add(c)
      for (let n of c.needs) {
        _need(i, n)
      }
    }
  }

  for (let i of items) {
    for (let n of i.needs) {
      _need(i, n)
    }
  }

  items = [...res].reverse()

  return items
}

//
export async function run_borg_backup_on_project(args: RunBorgOnProjectOptions & Command) {

  args.binds ??= []

  // Get all containers pertaining to a given work directory
  const containers = args.containers ?? await docker.listContainers({ label: [
    `com.docker.compose.project=${args.project_name}`
  ] })

  if (!args.project_name || !containers?.length) {
    throw new Error("project not found")
  }

  const infos = await Promise.all(containers.map(c => new Container(docker.modem, c.Id).inspect()))

  let working_dir: string | null = null

  for (let c of infos) {

    const service = c.Config.Labels["com.docker.compose.service"]

    // We add the compose working dir if there was one
    if (!working_dir) {
      working_dir = c.Config.Labels["com.docker.compose.project.working_dir"]
      if (working_dir) {
        args.binds.push(
          `${working_dir}:/data/__compose__`,
        )
      }
    }

    const c2 = new Container(docker.modem, c.Id)
    const inspect = await c2.inspect()
    // Put all the mounts of the service into /data/<service>/<destination>
    // we exclude those that were inside the working directory of the project
    args.binds.push(
      ...inspect.Mounts
      .filter(
        m => !working_dir || (path.relative(working_dir, m.Source).includes("..") && working_dir !== m.Source)
      )
      .map(m => {
        const res = `${m.Source}:${path.join(`/data/${service}`, m.Destination)}:rw`
        return res
      })
    )
  }

  // Figure out dependencies
  const deps_to_stop = figure_out_container_deps(infos)
    .filter(d => d.running)

  if (!args.keep_running) {
    // Stop the stack
    await Promise.all(deps_to_stop.slice().reverse().map(dep => {
      console.log(ch.redBright(" ⏹︎ ") + "stopping " + ch.redBright([...dep.provides]))
      containers_to_restart.add(dep.info.Id)
      return new Container(docker.modem, dep.info.Id).stop()
    }))
  }

  // Run borg-backup
  console.log(STAR, "running borg")
  await run_borg_backup(args)

  if (args.keep_running) {
    return
  }

  // Relaunch the stack
  let proms: Promise<any>[] = []
  const active = new Set<string>()
  console.log(STAR, "relaunching containers")
  for (let c of deps_to_stop) {
    const cont = new Container(docker.modem, c.info.Id)

    // If it needs containers, wait for them to be relaunched
    if (c.needs.size && [...c.needs].filter(n => !active.has(n))) {
      await Promise.all(proms)
      proms = []
    }

    console.log(ch.greenBright(" ▶ ") + "restarting " + ch.greenBright([...c.provides]))
    // Launch the container, and mark it as active when it is done
    proms.push(cont.start().then(_ => {
      // give 1s, just in case...
      return new Promise(acc => setTimeout(acc, 1000))
    }).then(() => {
      for (let prov of c.provides) {
        active.add(prov)
      }
      containers_to_restart.delete(c.info.Id)
    }))
  }

  await Promise.all(proms)
}


export interface DoProjectBackup extends RunBorgOnProjectOptions {
  repository: string
  archive: string
  prune: string
  user: string
  group: string
}


export async function do_project_backup(opts: DoProjectBackup) {

  const is_ssh = opts.repository.includes("@")
  const prune = opts.prune
  log_value(opts, "prune")
  log_value(opts, "archive")

  await run_borg_backup_on_project({
    ...opts,
    command: command_tag`
borg init --log-json -e ${opts.passphrase ? "repokey-blake2" : "none"} ${is_ssh ? opts.repository : "/repository"}

cd /data && borg create --progress --json --log-json --stats "::${opts.archive}" ./*

${prune ? `
  borg prune ${prune} --log-json -s --list ::`
  : ''
}
chown -R ${opts.user}:${opts.group} /repository`
  })

  // 2. Add all the mounts that are not in the working dir into

}

export interface DoProjectRestore extends RunBorgOnProjectOptions {
  archive: string
}

export async function do_project_restore(opts: DoProjectRestore) {
  if (!opts.containers?.length) {
    throw new Error("nope")
  }

  await run_borg_backup_on_project({
    ...opts,
    leave_wd: true, // do not touch
    command: command_tag`
cd /data && borg extract --progress --log-json --list -e "__compose__" -v "::${opts.archive}"
`
  })

}

export async function do_project_restore_tar(opts: DoProjectRestore) {

  opts.binds ??= []
  opts.binds.push(`${opts.archive}:/output.tar.xf:ro`)

  await run_borg_backup_on_project({
    ...opts,
    leave_wd: true,
    command: command_tag`
cd /data && tar xfp /output.tar.xf
`
  })
}


export interface DoExportTar extends RunBorgOptions {
  repository: string
  archive: string
  tarpath: string
}

/** Export an archive to a tarball */
export async function do_export_tar(opts: DoExportTar) {

  opts.binds ??= []
  opts.binds.push(`${opts.tarpath}:/output.tar.xf:rw`)
  helpers.touch(opts.tarpath)

  await run_borg_backup({
    ...opts,
    repository: opts.repository,
    config: opts.config,
    command: `borg export-tar --log-json "/repository::${opts.archive}" "/output.tar.xf"`,
  })
}

/** Stop a container "properly ?" */
export async function container_stop(container: Docker.Container) {
  try {
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
  } finally {
    // containers_to_stop_and_delete.delete(container.id)
  }
}


export async function container_start(container: Docker.Container) {
  const infos = await container.inspect()
  if (!infos.State.Running) {
    console.log(ch.greenBright(" ▶ ") + " starting " + ch.greenBright(infos.Name))
    container.start()
  }
}

const containers_to_restart = new Set<string>()
const containers_to_stop_and_delete = new Set<string>()

async function terminate() {
  // console.error(ch.redBright("entering error mode"))
  for (let c of containers_to_restart) {
    try {
      console.error(`trying to restart ${c}`)
      await container_start(docker.getContainer(c))
    } finally { containers_to_restart.delete(c) }
  }
  for (let c of containers_to_stop_and_delete) {
    try {
      console.error(`trying to stop ${c}`)
      await container_stop(docker.getContainer(c))
    } finally { containers_to_stop_and_delete.delete(c) }
  }
}

process.on("beforeExit", () => {
  terminate()
})

for (const sig of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
]) {
  process.on(sig, function (code) {
      terminate().then(() => {
        process.exit(code)
      })
      console.log('signal: ' + sig)
  })
}
