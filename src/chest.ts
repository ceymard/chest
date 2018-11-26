import * as path from 'path'
import * as Docker from 'dockerode'
import { Transform } from 'stream';

const d = new Docker()
const BORG_IMAGE = 'ceymard/borg'

async function setupLogging(cont: Docker.Container) {

  const stream = await cont.logs({stdout: true, stderr: false, follow: true})
  cont.modem.demuxStream(stream, process.stdout, process.stderr)
}

/**
 * Backup a container
 */
async function backup(id: string, args: string[]) {
  const cont = await d.getContainer(id)
  const infos = await cont.inspect()
  const CONT_WAS_RUNNING = !!infos.State.Running

  var IS_REPO = false
  var IS_DATA = false
  args = args.map(a => {
    if (a.indexOf('%repo') > -1) {
      IS_REPO = true
    }
    if (a.indexOf('%data') > -1) {
      IS_DATA = true
    }
    return a.replace(/%repo/g, '/repository')
      .replace(/%data/g, '/staging')
  })

  const binds = infos.Mounts.map(m => `${m.Source}:${path.join(`/staging`, m.Destination)}:ro`)
  binds.push('/etc/localtime:/etc/localtime:ro')
  binds.push('/etc/timezone:/etc/timezone:ro')
  binds.push(`${path.join(process.env.HOME!, '.chest/backups/', infos.Name.replace(/^.*\//, ''))}:/repository:rw`)

  if (IS_REPO) { }

  var borg!: Docker.Container
  try {
    if (IS_DATA) {
      console.log(`Stopping ${infos.Name}`)
      await cont.stop()
    }
    borg = await d.createContainer({
      Image: BORG_IMAGE,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: binds
      },
      Env: [
        'BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=yes',
        'BORG_RELOCATED_REPO_ACCESS_IS_OK=yes'
      ],
      Cmd: args
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

const args = process.argv.slice(2)
backup(args[0], args.slice(1)).catch(e => console.error(e))
