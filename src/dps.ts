import * as Docker from 'dockerode'
import * as c from 'colors/safe'

async function run(all: boolean) {
  const d = new Docker()
  const out = process.stdout

  const containers = await d.listContainers({all})

  containers.sort((a, b) => a.Names[0] < b.Names[0] ? -1 : a.Names[0] > b.Names[0] ? 1 : 0)

  var current_project = null as null | string

  for (var cont of containers) {
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
    out.write(ips.join(', ') + '\t')

    if (dc_project) {
      canonical = canonical.replace(dc_project, c.gray(dc_project))
    }

    out.write(canonical + ' ')
    if (labels['chest.auto-backup'])
      out.write(c.bold(c.magenta('backuped')))

    var ports = cont.Ports.filter(p => p.PublicPort).map(p => `${c.bold(c.green(p.PublicPort.toString()))} => ${p.PrivatePort}/${p.Type}`).join(', ')
    if (ports)
      out.write(ports)
  }
  out.write('\n')

}

run(process.argv[2] === '-a').catch(e => console.error(e))