import { version } from "../package.json"
import { Type, command, flag, option, optional, positional, run, string, subcommands } from "cmd-ts"
import * as api from "./api"
import * as _ch from "chalk"
import * as os from "os"
import * as fs from "fs"
import * as readline from "readline"

const ch = new _ch.Chalk()
const BACKUPS_DIR = process.env["CHEST_BACKUPS_DIR"] ?? `${os.homedir()}/backups`
const STAR = ch.greenBright(" *")

function show(name: string, value: string) {
  console.log(`${ch.bold.green(" *")} ${name}: ${ch.cyan(value)}`)
}

function formatBytes(bytes: number | null | undefined, decimals = 2) {
  if (!bytes) return '0 Bytes'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}


function ensure_valid_repository(repo: string) {
  if (!fs.statSync(repo, { throwIfNoEntry: false })?.isDirectory()) {
    fs.mkdirSync(repo, { recursive: true })
  }
}

let _cont: api.RuntimeInfos = {
  binds: [],
  chest: {},
  compose: {},
}

const ContainerOption: Type<string, api.RuntimeInfos> = {
  async from(input: string) {
    const  result = await api.getContainerDescription(input)
    _cont = result
    return result
  }
}

function map<R = string, T = R>(fn: (val: T) => R): Type<T, R> {
  return {
    async from(input: T) {
      return fn(input)
    }
  }
}


const opt_container_required = option({
  description: "a container name",
  short: "c",
  long: "container",
  type: ContainerOption,
})

const opt_container_optional = option({
  description: "a container name",
  short: "c",
  long: "container",
  type: optional(ContainerOption),
})


const archive = option({
  long: "archive",
  short: "a",
  description: "an archive name",
})

const opt_keep_running = flag({
  long: "keep-running",
  description: "do not stop the container from running",
  type: optional(map((opt: boolean) => {
    _cont.chest.keep_running = opt
    return opt
  }))
})


function autoArchiveName(infos: api.RuntimeInfos) {
  return (infos.chest.prefix || infos.infos?.Id || "chest") + "-" + api.getTimestamp()
}


const opt_archive = option({
  long: "archive",
  short: "a",
  description: "an archive name (use <chest list> to list them)",
  type: map((res) => {
    _cont.chest.archive = res
    return res
  }),
  defaultValue() {
    const res = autoArchiveName(_cont)
    _cont.chest.archive = res
    show("archive", res)
    return res
  },
})


function autoRepository(cont: api.RuntimeInfos) {
  return cont.chest.repository ?? `${BACKUPS_DIR}/${cont.chest.name}`
}

const opt_repository = option({
  long: "repository",
  short: "r",
  description: "a path to a repository if not inferring from labels",
  type: map((res: string) => {
    _cont.chest.repository = res
    return res
  }),
  defaultValue: () => {
    let res = autoRepository(_cont)

    if (res == null) {
      throw new Error("no repository found in container, please provide one")
    }

    show("repository", res)

    _cont.chest.repository = res
    return res
  },
})


////////////////////////////////////////////////////


const cmd_extract = command({
  name: "extract",
  description: "extract data from a backup",
  version,
  args: {
    archive,
    output_directory: option({
      long: "output",
      short: "o",
      description: "the directory where to output the extract",
    })
  },
  handler: args => {

  },
})


async function __backup(cont: api.RuntimeInfos) {
  const is_ssh = cont.chest.repository?.includes("@")

  if (is_ssh) {
    console.error(ch.bold.redBright(` ⚠⚠⚠ warning : you are about to backup to a remote server. This is dangerous, you may be inadvertently trying to backup to an existing backup.\n`))
    const int = readline.createInterface({input: process.stdin, output: process.stderr})
    const res = await new Promise<string>(acc => {
      int.question("Continue ? y/n ", ans => {
        acc(ans)
      })
    })
    if (res.toLowerCase() !== "y") {
      console.error("aborting.")
      return
    }
    int.close()
  }

  if (!is_ssh)
    ensure_valid_repository(cont.chest.repository!)

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
  await api.runBorg(cont, `
    #if grep repository /repository/config > /dev/null 2>&1 ; [ "$?" -ne 0 ]; then
      borg init --log-json -e ${cont.chest.passphrase ? "repokey-blake2" : "none"} ${is_ssh ? cont.chest.repository : "/repository"}
    #fi
    cd /data && borg create --progress --json --log-json --stats "::${cont.chest.archive}" ./*
    ${prune ? `
    # borg prune ${prune} --log-json -P "${cont.chest.prefix}" -s --list ::` : ''}
  `, (out) => {

    // console.log(out)
    console.log(STAR, `duration ${ch.greenBright(Math.round(100 * out.archive.duration)/100)}s`)
    console.log(STAR, `deduplicated size ${ch.greenBright(formatBytes(out.archive.stats.deduplicated_size))}, uncompressed ${ch.redBright(formatBytes(out.archive.stats.original_size))}`)
    console.log(STAR, `repository size ${ch.greenBright(formatBytes(out.cache.stats.unique_csize))}`)
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


const cmd_backup = command({
  name: "backup",
  version: version,
  description: "backup a container to a borg repository",
  args: {
    opt_container: opt_container_required,
    opt_archive,
    opt_keep_running,
    opt_repository,
  },
  handler: async args => {
    await __backup(_cont)
  }
})


const cmd_backup_all = command({
  name: "backup-all",
  description: "backup all containers that have chest.auto-backup labels set",
  version: version,
  args: { },
  handler: async args => {

    const all = await api.docker.listContainers({all: true})
    for (var cont of all) {
      if (cont.Labels['chest.auto-backup']) {
        console.log(ch.greenBright(" ***"), "backuping", ch.bold.yellowBright(cont.Names[0]))
        const c = await api.getContainerDescription(cont.Id)
        c.chest.archive = autoArchiveName(c)
        c.chest.repository = autoRepository(c)
        await __backup(c)
      }
    }
  }
})


const cmd_restore = command({
  name: "restore",
  description: "restore a container to a preceding backup",
  version: version,
  args: {
    opt_container: opt_container_required,
    opt_repository,
    archive: option({
      description: "the archive name",
      short: "a",
      long: "archive"
      // displayName: "archive",
    })
  },
  handler: async args => {

    if (_cont.infos?.State.Running) {
      console.error(ch.redBright("please shutdown the container and its whole stack before restoring to avoid inconsistencies and corrupted backups"))
      return
    }

    await api.runBorg(_cont, `cd /data && borg extract --progress --log-json --list -v "::${args.archive}"`,
      out => {
        console.log(out)
      }, err => {
        if (err.type === "progress_percent" && !err.finished) {
          process.stderr.clearLine(0)
          process.stderr.cursorTo(0)
          process.stderr.write(`${ch.magentaBright(" -")} ${formatBytes(err.current)}/${formatBytes(err.total)}`)
        } else if (err.finished) {
          process.stderr.write("\n")
        }
        // console.log(err)
      })
  }
})


const cmd_list = command({
  name: "list",
  version,
  description: "List archives in a repository or a container",
  args: {
    container: opt_container_optional,
    repository: opt_repository,
  },
  handler: async args => {
    if (args.container) {
      args.container.chest.keep_running = true
    }
    await api.runBorg(_cont, `borg list --json --log-json --format="{archive}{NL}" ::`, out => {
      for (const arch of out.archives) {
        console.log(STAR, arch.name, ch.grey(arch.time))
      }
    })
  }
})


const cmd_extract_compose = command({
  name: "extract-compose",
  version,
  description: "extract compose files from a backup",
  args: {
    repository: opt_repository,
    container: opt_container_optional,
    archive: opt_archive,
  },
  handler: async args => {
    if (args.container) {
      args.container.chest.keep_running = true
    }
    _cont.binds.push(`${process.cwd()}:/cwd:rw`)
    await api.runBorg(_cont, `cd /cwd && borg extract --progress --log-json --list -v --pattern '*.yml' "::${args.archive}"`, out => {
      for (const arch of out.archives) {
        console.log(STAR, arch.name, ch.grey(arch.time))
      }
    })
  }
})


const opts = subcommands({
  name: "chest",
  version: version,
  cmds: {
    backup: cmd_backup,
    "backup-all": cmd_backup_all,
    "extract-compose": cmd_extract_compose,
    restore: cmd_restore,
    list: cmd_list,
    extract: cmd_extract
  },
})


run(opts, process.argv.slice(2))
