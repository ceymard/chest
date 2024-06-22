#!/usr/bin/env node
import Docker from 'dockerode'
// import col from 'colors/safe'
import ch from "chalk"

interface Options {
  all: boolean
  verbose: boolean
  filter: string
  urls: boolean
}

interface ContainerInfos {
  compose: string
  composePath: string
  composeService: string
  image: string

  name: string
  running: boolean
  status: string
  ips: string[]
  ports: {public: boolean, ip?: string, host: number, local: number, type: string}[]
  urls: string[]
  backuped: boolean
  backupName: string
  ovh: string
  volumes: {inside: string, local: string, rw: boolean, type: "bind" | "volume"}[]
}

const out = process.stdout

// ┏ ┗  ┓ ┛ ━ ┃ ┣ ┫ ┅ ┇
// c.compose, c.composePath

function display(c: ContainerInfos, opts: Options): string[] {

  if (opts.urls) {
    if (!c.urls.length) return []
    for (let u of c.urls) {
      out.write(ch.cyan(`🌐 https://${u} ${ch.gray(c.compose)} ${ch.gray(c.name)}${c.ovh ? " dyndns":""}\n`))
    }
    return []
  }


  const res: string[] = []

  let runcol = c.running ? ch.bgAnsi256(82).ansi256(0) : ch.bgRed.ansi256(52)
  res.push(` ${c.running ? ch.green("⏵") : ch.red("⏸")} ${c.name.replace(c.composeService, e => ch.bold(runcol(e)))}.docker`)

  res.push(`  ${ch.grey(c.image.replace(/:[^]*$/, m => ch.bold(ch.blue(m))))}`)

  if (c.ips.length > 0) {
    let str = `  ${ch.gray(c.ips.join(" "))}`
    for (let p of c.ports) {
      str += ` ${p.public ? ch.red(ch.bold(p.ip??"0.0.0.0")) + "@" + p.host + ":": ""}${ch.yellow(p.local.toString())}/${p.type}`
    }
    res.push(str)
  } else {
    res.push(`  ${ch.yellow("host:net")}`)
  }

  if (c.backupName) {
    res.push(ch.magenta(`  💾 ${c.backuped ? ch.green(ch.bold("auto ")) : ""}${c.backupName}`))
  }

  for (let u of c.urls) {
    res.push(ch.cyan(`  🌐 https://${u}`))
  }

  if (opts.verbose) {
    for (let v of c.volumes) {
      res.push(ch.gray(`  🛢 ${ch.bold(v.inside)}: ${(v.type === "bind" ? ch.blue : ch.gray)(v.local)}`))
    }
  }

  return res
}

async function run(options: Options) {
  const d = new Docker()


  const containers = await d.listContainers({all: options.all})

  containers.sort((a, b) => a.Names[0] < b.Names[0] ? -1 : a.Names[0] > b.Names[0] ? 1 : 0)

  const infos: ContainerInfos[] = []
  const re_filter = options.filter ? new RegExp(options.filter, "i") : null

  for (let cont of containers) {

    const ct = d.getContainer(cont.Id)
    const cf = await ct.inspect()
    const urls: string[] = []
    for (let e of cf.Config.Env) {
      if (e.match(/^VIRTUAL_HOST/)) {
        e = e.replace('VIRTUAL_HOST=', '')
        urls.push(...e.split(/,/g))
      }
    }

    if (re_filter && !re_filter.test(cont.Names.join(" ")) && !re_filter.test(urls.join(" "))) continue

    const labels = cont.Labels

    const ips = Object.values(cont.NetworkSettings.Networks).map(net => net.IPAddress.trim()).filter(d => !!d)

    infos.push({
      image: cont.Image,
      compose: labels["com.docker.compose.project"] ?? "--no project--",
      composePath: labels["com.docker.compose.project.working_dir"] ?? "--compose too old, no path--",
      composeService: labels["com.docker.compose.service"],
      name: cont.Names[0].slice(1),
      running: cont.State === "running",
      status: cont.Status,
      volumes: cf.Mounts.map(mount => ({ inside: mount.Destination, local: mount.Source, rw: mount.RW, type: (mount as any).Type })),
      backuped: !!labels['chest.auto-backup'],
      backupName: labels["chest.name"],
      ovh: labels["com.ovh.dyndns-update"],
      urls,
      ips,
      ports: cont.Ports.map(p => ({ public: !!p.PublicPort, host: p.PublicPort, local: p.PrivatePort, type: p.Type, ip: p.IP })),
    })
  }

  infos.sort((a, b) => {
    if (a.compose < b.compose) return -1
    else if (a.compose > b.compose) return 1
    else if (a.name < b.name) return -1
    else if (a.name > b.name) return 1
    return 0
  })

  const inf2 = groupBy(infos, inf => inf.compose)

  const ansi = 16 + Math.round(Math.random() * 216)

  const bgfg = ch.ansi256(ansi)
  const bg = ch.bgAnsi256(ansi)
  const fg = ch.ansi256((ansi + 18) % 256)

  const TL = bgfg("┏━")
  const TR = bgfg("━┓")
  const V = bgfg("┃")
  const H = bgfg("━")

  console.log()
  for (let i of inf2) {

    const title = `${bg(fg(" " + i.key + " "))}${H}${ch.bgGrey(ch.white(" " +i.values[0].composePath+" "))}`
    const lines = i.values.map(v => display(v, options))
    const max = Math.max(strlen(title), ...lines.map(ln => Math.max(...ln.map(line => strlen(line)))))

    // ┏ ┗  ┓ ┛ ━ ┃ ┣ ┫ ┅ ┇

    console.log(`${TL}${title}${bgfg(fill("━", max - strlen(title)))}${TR}`)

    let j = 0
    for (let cont of lines) {
      console.log(bgfg(`┣${fill("━", max+2)}┫`))
      if (j > 0) {
      } else {
        // console.log(bgfg(`┃${fill(" ", max+2)}┃`))
      }
      j++

      // let [first, ...rest] = cont
      // console.log(`${V}${fill(" ", max + 2)}${V}`)
      // console.log(`${bgfg("┣")}${H}${first}${fill(" ", max - strlen(first) -1)} ${H}${bgfg("┫")}`)
      for (let r of cont) {
        console.log(`${V}${r}${fill(" ", max - strlen(r) + 2)}${V}`)
      }
    }

    console.log(bgfg(`┗${fill("━", max+2)}┛\n`))

  }

}

let args = process.argv.slice(2)
let options = { all: false, filter: "", verbose: false, urls: false }

for (let a of args) {
  if (a[0] === "-") {
    if (a.includes("a")) options.all = true
    if (a.includes("v")) options.verbose = true
    if (a.includes("u")) options.urls = true
  } else {
    options.filter = a
  }
}

run(options).catch(e => console.error(e))

function fill(str: string, len: number) {
  return new Array(len).fill(str).join("")
}

function strlen(str: string) {
  // console.log(str.length, str.replace(/\x1B\[[^m]*m/g, "").length)
  // console.log(JSON.stringify(str))
  return str.replace(/\x1B\[[^m]*m/g, "").length
}

function groupBy<T, V>(arr: T[], ex: (v: T) => V): { key: V, values: T[] }[] {
  return [...arr].sort((a, b) => {
    const e1 = ex(a), e2 = ex(b)
    return e1 < e2 ? -1 : e1 > e2 ? 1 : 0
  }).reduce((acc, item) => {
    const ki = ex(item)

    let last = acc[acc.length - 1]
    if (last && last.key === ki) {
      last.values.push(item)
    } else {
      acc.push({ key: ki, values: [item] })
    }
    return acc
  }, [] as { key: V, values: T[] }[])
}