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
      canonical = canonical.replace(dc_project, c.gray(dc_project))
    }

    out.write(canonical + ' ')
    if (labels['chest.auto-backup'])
      out.write(c.bold(c.magenta('backuped')))

    var ports = cont.Ports.filter(p => p.PublicPort).map(p => `${c.bold(c.green(p.PublicPort.toString()))} => ${p.PrivatePort}/${p.Type}`).join(', ')
    if (ports)
      out.write(ports)

    var publicports = Object.keys(cf.HostConfig.PortBindings).map(p => `${c.bold(c.green(p))}`).join(', ')
    if (publicports)
      out.write(publicports)
  }
  out.write('\n')

}

run(process.argv[2] === '-a').catch(e => console.error(e))