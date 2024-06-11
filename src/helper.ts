import * as fs from "fs"
import * as readline from "readline"
import JSONStream from "JSONStream"
import ch from "chalk"


export function ensure_valid_repository(repo: string) {
  if (!fs.statSync(repo, { throwIfNoEntry: false })?.isDirectory()) {
    fs.mkdirSync(repo, { recursive: true })
  }
}

export function formatBytes(bytes: number | null | undefined, decimals = 2) {
  if (!bytes) return '0 Bytes'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}


export async function question(prompt: string): Promise<string> {
  const int = readline.createInterface({input: process.stdin, output: process.stderr})
  const res = await new Promise<string>(acc => {
    int.question("Continue ? y/n ", ans => {
      acc(ans)
    })
  })
  int.close()
  return res
}


export function jsonStream(out?: (data: any, key: number) => any) {
  const res = new JSONStream.parse()

  let i = 0
  res.on("data", (data: any) => {
    out?.(data, i++)
  })

  res.on("error", (err: any) => {
    console.error(err)
  })

  return res
}


export function readEtcPasswd() {
  const passwd = new Map(fs.readFileSync("/etc/passwd", "utf-8")
    .split(/[ \t]*\n[ \t]*/g)
    .map(line => {
      const [user, _, uid, gid, gecos, home, shell] = line.split(/:/g)
      return [user, {
        user,
        uid: Number(uid),
        gid: Number(gid),
        gecos,
        home,
        shell
      }]
    }))
  return passwd
}

const is_tty = process.stderr.hasColors()

function p(stats: any) {
  if (!stats.nfiles) {
    return
  }
  process.stderr.clearLine(0)
  process.stderr.cursorTo(0)
  process.stderr.write(`${ch.magentaBright(" -")} ${formatBytes(stats.deduplicated_size)}/${formatBytes(stats.compressed_size)}/${formatBytes(stats.original_size)} - ${stats.nfiles} files`)
}

export const stderr_progress = !is_tty ? undefined : function stderr_progress(err: any, key: number) {
  if (err.type === "progress_percent" && !err.finished) {
    process.stderr.clearLine(0)
    process.stderr.cursorTo(0)
    process.stderr.write(`${ch.magentaBright(" -")} ${formatBytes(err.current)}/${formatBytes(err.total)}`)
  } else if (err.type === "progress_percent" && err.finished) {
    process.stderr.clearLine(0)
    process.stderr.cursorTo(0)
    // process.stderr.write("\n")
  } else if (err.type === "archive_progress") {
    process.stderr.clearLine(0)
    process.stderr.cursorTo(0)
    p(err)
    if (err.finished) {
      process.stderr.write("\n\n")
    }
  } else if (err.archive) {
    const s = err.archive.stats
    p(s)
    process.stderr.write("\n")
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


export function getTimestamp2() {
  const d = new Date()
  var pad = (n: number) => n < 10 ? '0' + n : n.toString()
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s${d.getMilliseconds()}ms`
}


export function touch(path: string) {
  const time = new Date()
  try {
    fs.utimesSync(path, time, time);
  } catch (e) {
      let fd = fs.openSync(path, 'a');
      fs.closeSync(fd);
  }
}