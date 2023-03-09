#!/usr/bin/env node
import Docker from 'dockerode'
import * as col from 'colors/safe'

interface Options {
  all: boolean
  verbose: boolean
  filter: string
}

interface ContainerInfos {
  compose: string
  composePath: string
  composeService: string

  name: string
  running: boolean
  status: string
  ips: string[]
  ports: {public: boolean, ip?: string, host: number, local: number, type: string}[]
  urls: string[]
  backuped: boolean
  backupName: string
  volumes: {inside: string, local: string, rw: boolean, type: "bind" | "volume"}[]
}

const out = process.stdout

let current_compose = ""
function display(c: ContainerInfos, opts: Options) {
  if (current_compose !== c.compose) {
    current_compose = c.compose
    out.write(`${col.bold(c.compose)}\n`)
  }

  let r = c.running ? col.green : col.red
  out.write(`  ${c.running ? col.green("⏵") : col.red("⏸")} ${c.name.replace(c.composeService, e => col.bold(r(e)))}.docker`)

  if (c.ips.length > 0) {
    out.write(` ${col.gray(c.ips.join(" "))}`)
  } else {
    out.write(` ${col.yellow("host:net")}`)
  }

  for (let p of c.ports) {
    out.write(` ${p.public ? col.red(col.bold(p.ip??"0.0.0.0")) + "@" + p.host + ":": ""}${col.yellow(p.local.toString())}/${p.type}`)
  }

  out.write("\n")

  if (c.backupName) {
    out.write(col.magenta(`    💾 ${c.backuped ? col.green(col.bold("auto ")) : ""}${c.backupName}\n`))
  }

  for (let u of c.urls) {
    out.write(col.cyan(`    🌐 ${u}\n`))
  }

  if (opts.verbose) {
    for (let v of c.volumes) {
      out.write(col.gray(`    🛢 ${col.bold(v.inside)}: ${(v.type === "bind" ? col.blue : col.gray)(v.local)}\n`))
    }
  }
}

async function run(options: Options) {
  const d = new Docker()


  const containers = await d.listContainers({all: options.all})

  containers.sort((a, b) => a.Names[0] < b.Names[0] ? -1 : a.Names[0] > b.Names[0] ? 1 : 0)

  const infos: ContainerInfos[] = []
  const re_filter = options.filter ? new RegExp(options.filter, "i") : null

  for (let cont of containers) {
    if (re_filter && !re_filter.test(cont.Names.join(" "))) continue

    const ct = await d.getContainer(cont.Id)
    const cf = await ct.inspect()

    const labels = cont.Labels

    const ips = Object.values(cont.NetworkSettings.Networks).map(net => net.IPAddress.trim()).filter(d => !!d)

    const urls: string[] = []
    for (let e of cf.Config.Env) {
      if (e.match(/^VIRTUAL_HOST/)) {
        e = e.replace('VIRTUAL_HOST=', '')
        urls.push(...e.split(/,/g))
      }
    }

    infos.push({
      compose: labels["com.docker.compose.project"] ?? "--no project--",
      composePath: labels["com.docker.compose.project.working_dir"],
      composeService: labels["com.docker.compose.service"],
      name: cont.Names[0].slice(1),
      running: cont.State === "running",
      status: cont.Status,
      volumes: cf.Mounts.map(mount => ({ inside: mount.Destination, local: mount.Source, rw: mount.RW, type: (mount as any).Type })),
      backuped: !!labels['chest.auto-backup'],
      backupName: labels["chest.name"],
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

  for (let i of infos) {
    display(i, options)
  }

}

let args = process.argv.slice(2)
let options = { all: false, filter: "", verbose: false }

for (let a of args) {
  if (a[0] === "-") {
    if (a.includes("a")) options.all = true
    if (a.includes("v")) options.verbose = true
  } else {
    options.filter = a
  }
}

run(options).catch(e => console.error(e))
