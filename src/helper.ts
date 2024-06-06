import * as fs from "fs"
import * as readline from "readline"
import * as es from "event-stream"
import { parser } from "stream-json"
import StreamValues from "stream-json/streamers/StreamValues"


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


export async function jsonStream(out?: (data: any, key: number) => any) {
  const res = es.pipeline(
    parser({ jsonStreaming: true }),
    new StreamValues(),
    es.mapSync((data: any) => {
      out?.(data.value, data.key)
      return data
    })
  )

  res.on("error", err => {
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