import { version } from "../package.json"
import { Type, command, option, positional, run, string, subcommands } from "cmd-ts"
import * as api from "./api"
import * as _ch from "chalk"
import * as os from "os"
import * as fs from "fs"

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

let _cont!: api.ContainerDescription

const ContainerOption: Type<string, api.ContainerDescription> = {
  async from(input: string) {
    const  result = await api.getContainerDescription(input)
    _cont = result
    return result
  }
}


const container = positional({
  description: "a container name",
  displayName: "container",
  type: ContainerOption,
})


const archive = option({
  long: "archive",
  short: "a",
  description: "an archive name",
})


const optional_archive = option({
  long: "archive",
  short: "a",
  description: "an archive name (use <chest list> to list them)",
  defaultValue() {
    const res = (_cont.chest.prefix || _cont.infos.Id) + "-" + api.getTimestamp()
    show("archive", res)
    return res
  },
})

const repository = option({
  long: "repository",
  short: "r",
  description: "a path to a repository if not inferring from labels",
  defaultValue: () => {
    let res = _cont.chest.repository ?? `${BACKUPS_DIR}/${_cont.chest.name}`

    if (res == null) {
      throw new Error("no repository found in container, please provide one")
    }

    show("repository", res)

    _cont.chest.repository = res
    return res
  },
})


////////////////////////////////////////////////////


const extract = command({
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


const backup = command({
  name: "backup",
  version: version,
  args: {
    container,
    optional_archive,
    repository,
  },
  handler: async args => {
    ensure_valid_repository(args.repository)
    let prune = _cont.chest.prune
    if (prune === 'auto') {
      prune = '--keep-daily 7 --keep-weekly 2 --keep-monthly 1'
    } else if (prune && !prune.includes('-')) {// no real arguments to prune
      prune = ''
    }

    // FIXME should prune on prefix only !
    await api.runBorgOnContainer(_cont, `
      if grep repository /repository/config > /dev/null 2>&1 ; [ "$?" -ne 0 ]; then
        borg init --log-json -e ${_cont.chest.passphrase ? "repokey-blake2" : "none"} /repository
      fi
      cd /data && borg create --progress --json --log-json --stats "::${args.optional_archive}" ./*
      ${prune ? `
      # borg prune ${prune} --log-json -P "${_cont.chest.prefix}" -s --list ::` : ''}
    `, (out) => {

      // console.log(out)
      console.log(STAR, `duration ${ch.greenBright(Math.round(100 * out.archive.duration)/100)}s`)
      console.log(STAR, `deduplicated size ${ch.greenBright(formatBytes(out.archive.stats.deduplicated_size))}, uncompressed ${ch.redBright(formatBytes(out.archive.stats.original_size))}`)
      console.log(STAR, `repository size ${ch.greenBright(formatBytes(out.cache.stats.unique_csize))}`)
      console.log(ch.greenBright("->"), ch.bold.magentaBright(out.archive.name))
    }, err => {
      if (err.type === "progress_percent" || err.type === "progress_message") {
        process.stderr.clearLine(0)
        process.stderr.cursorTo(0)
        if (!err.finished) {
          process.stderr.write(err.message)
        }
      }
      // console.log(err)
    })
  }
})


const backupAll = command({
  name: "backup-all",
  description: "backup all containers that have chest.auto-backup labels set",
  version: version,
  args: { },
  handler: args => {
    console.log("coucou")
  }
})


const restore = command({
  name: "restore",
  description: "restore a container to a preceding backup",
  version: version,
  args: {
    container,
    repository,
    archive: option({
      description: "the archive name",
      short: "a",
      long: "archive"
      // displayName: "archive",
    })
  },
  handler: async args => {
    await api.runBorgOnContainer(_cont, `cd /data && borg extract --progress --log-json --list -v "::${args.archive}"`,
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


const list = command({
  name: "list",
  version,
  description: "List archives in a container's backup",
  args: {
    container,
    repository,
  },
  handler: async args => {
    args.container.chest.keep_running = true
    await api.runBorgOnContainer(args.container, `borg list --json --log-json --format="{archive}{NL}" ::`, out => {
      for (const arch of out.archives) {
        console.log(STAR, arch.name, ch.grey(arch.time))
      }
    })
  }
})


const showcompose = command({
  name: "show-compose",
  version,
  description: "Show the docker-compose.yml associated with this project",
  args: { },
  handler: args => {

  }
})


const opts = subcommands({
  name: "chest",
  version: version,
  cmds: { backup, "backup-all": backupAll, restore, list, extract },
})


run(opts, process.argv.slice(2))
