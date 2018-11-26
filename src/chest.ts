import * as path from 'path'
import * as Docker from 'dockerode'

const d = new Docker()
const BORG_IMAGE = 'ceymard/borg'

async function setupLogging(cont: Docker.Container) {

  const stream = await cont.logs({stdout: true, stderr: true, follow: true})
  cont.modem.demuxStream(stream, process.stdout, process.stderr)
}

/**
 * Backup a container
 */
async function runBorgOnContainer(id: string, dir: string, args: string) {
  const cont = await d.getContainer(id)
  const infos = await cont.inspect()
  const CONT_WAS_RUNNING = !!infos.State.Running

  var IS_DATA = false
  // args = args.map(a => {
  if (args.indexOf('%data') > -1) {
    IS_DATA = true
  }

  args = args.replace(/%repo/g, '/repository')
      .replace(/%data/g, '/staging')

  const binds = infos.Mounts.map(m => `${m.Source}:${path.join(`/staging`, m.Destination)}:ro`)
  binds.push('/etc/localtime:/etc/localtime:ro')
  binds.push('/etc/timezone:/etc/timezone:ro')
  binds.push(`${dir}:/repository:rw`)

  var borg!: Docker.Container
  try {
    if (IS_DATA) {
      console.log(`Stopping ${infos.Name}`)
      await cont.stop()
    }

    // console.log(`running /bin/ash -c ${args}`)
    borg = await d.createContainer({
      Image: BORG_IMAGE,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: binds
      },
      WorkingDir: '/staging',
      Entrypoint: '/bin/ash',
      Env: [
        'BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=yes',
        'BORG_RELOCATED_REPO_ACCESS_IS_OK=yes'
      ],
      Cmd: ['-c', args]
    })

    await borg.start();
    await setupLogging(borg)
    await borg.wait()

    if ((await borg.inspect()).State.Running)
      await borg.stop()
  } finally {
    // Stop borg if it is still running but errored
    try {
      if (borg && (await borg.inspect()).State.Running)
        await borg.stop()
    } catch { }

    // Restart container if it was running before
    try {
      if (IS_DATA && CONT_WAS_RUNNING && !(await cont.inspect()).State.Running) {
        console.log(`Restarting ${infos.Name}`)
        await cont.start()
      }
    } catch { }
    if (borg)
      await borg.remove()
  }

}


function usage() {
  console.log(`usage: chest <container> <backup|restore|exec|list> [arguments]`)
  process.exit(1)
}

const [contdesc, command, ...args] = process.argv.slice(2)
if (!command) {
  usage()
}
var [container, dir] = contdesc.split(':')
dir = dir || path.join(process.env.HOME!, '.chest/backups/', container.replace(/^.*\//, ''))

if (command === 'exec') {
  runBorgOnContainer(container, dir, args.join(' ')).catch(e => console.error(e))
} else if (command === 'backup') {
  const now = [args[0], (new Date()).toJSON()].filter(q => q).join('-')

  // FIXME should prune on prefix only !
  runBorgOnContainer(container, dir, `
    if grep repository %repo/config > /dev/null 2>&1 ; [ "$?" -ne 0 ]; then
      borg init -e "none" %repo
    fi
    cd %data && borg create --stats "%repo::${now}" ./*
    borg prune --keep-daily 7 --keep-weekly 2 --keep-monthly 1 --list --stats %repo
  `)
} else if (command === 'list') {
  runBorgOnContainer(container, dir, `borg list %repo`)
} else if (command === 'show') {
  runBorgOnContainer(container, dir, `borg list %repo::${args[0]}`)
} else {
  usage()
}
