import * as Docker from 'dockerode'
import * as c from 'colors/safe'

async function run(all: boolean) {
  const d = new Docker()
  const out = process.stdout

  const containers = await d.listContainers({all})

  containers.sort((a, b) => a.Names[0] < b.Names[0] ? -1 : a.Names[0] > b.Names[0] ? 1 : 0)

  var current_project = null as null | string

  for (var cont of containers) {
    const ct = await d.getContainer(cont.Id)
    const cf = await ct.inspect()

    var canonical = cont.Names[0].slice(1)
    const labels = cont.Labels
    var dc_project = labels['com.docker.compose.project']

    if (current_project == null || current_project !== dc_project) {
      out.write('\n')
    }

    var networks = cont.NetworkSettings.Networks
    var ips = [] as string[]
    for (var x in networks) {
      ips.push(networks[x].IPAddress)
    }

    ips = ips.filter(i => i)
    if (ips.length)
      out.write(ips.join(', ') + '\t')
    else
      out.write(c.yellow('*host-net*') + '\t')

    if (dc_project) {
      canonical = canonical.replace(dc_project, c.cyan(dc_project))
    }

    out.write(canonical + '.docker ')

    const more_infos = [] as string[]

    for (let e of cf.Config.Env) {
      if (e.match(/^VIRTUAL_HOST/)) {
        e = e.replace('VIRTUAL_HOST=', '')
        more_infos.push(c.gray(e))
      }
    }

    if (labels['chest.auto-backup'])
      more_infos.push(c.magenta('backuped'))

    for (let p of cont.Ports) {
      if (p.PublicPort) {
        more_infos.push(`${p.IP || '0.0.0.0@'}${c.bold(c.green(p.PublicPort.toString()))} => ${p.PrivatePort}/${p.Type}`)
      } else {
        more_infos.push(`${c.bold(c.yellow(p.PrivatePort.toString()))}/${p.Type}`)
      }
    }

    if (cf.HostConfig.NetworkMode === 'host') {
      for (let key in cf.HostConfig.PortBindings) {
        var ppor = cf.HostConfig.PortBindings[key]
        for (let p of ppor) {
          more_infos.push((p.HostIp || '0.0.0.0') + '@' + c.bold(c.green(p.HostPort)))
        }
          // more_infos.push(JSON.stringify(p))
      }
    }

    if (more_infos.length)
      out.write('\t' + more_infos.join(' '))
  }
  out.write('\n')

}

run(process.argv[2] === '-a').catch(e => console.error(e))