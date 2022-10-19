#!/usr/bin/env node
import * as path from 'path'
import Docker from 'dockerode'
import * as fs from 'fs'

const d = new Docker()
const BORG_IMAGE = 'ceymard/borg'


/**
 * A simple timestamping function that returns string like '181101-030024'.
 *
 * We use this format because selecting it in a terminal won't choke, whereas
 * using a regular date time format tends to not select text past the ':'
 */
function getTimestamp() {
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

/**
 * Run the given command in the container.
 */
async function runBorgOnContainer(cont: Docker.Container | null, dir: string, args: string) {
  const infos = cont ? await cont.inspect() : null

  const binds: string[] = infos ? infos.Mounts.map(m => `${m.Source}:${path.join(`/staging`, m.Destination)}:rw`) : []
  binds.push('/etc/localtime:/etc/localtime:ro')
  binds.push('/etc/timezone:/etc/timezone:ro')
  binds.push(`${dir}:/repository:rw`)

  const env = [
    'BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=yes',
    'BORG_RELOCATED_REPO_ACCESS_IS_OK=yes',
    'BORG_HOSTNAME_IS_UNIQUE=no',
    'BORG_REPO=/repository'
  ]

  const CONT_WAS_RUNNING = infos && !!infos.State.Running
  const labels = infos ? infos.Config.Labels : {}

  const passphrase = process.env.BORG_PASSPHRASE || labels['borg.passphrase'] || ''
  if (passphrase)
    env.push(`BORG_PASSPHRASE=${passphrase}`)

  var SHOULD_SHUTDOWN = false
  if (args.match(/%data/i) && !labels['chest.keep-running']) {
    SHOULD_SHUTDOWN = true
  }

  args = args.replace(/%repo/g, '/repository')
    .replace(/%data/g, '/staging')

  var borg: Docker.Container | undefined
  const try_stop = async (container: Docker.Container) => {
    const running = (await container.inspect()).State.Running
    if (running)
      await container.stop()
    return running
  }
  try {
    if (cont && infos && SHOULD_SHUTDOWN) {
      console.log(`Stopping ${infos.Name}`)
      await try_stop(cont)
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
      Env: env,
      Cmd: ['-c', args]
    })

    await borg.start();
    const stream = await borg.logs({stdout: true, stderr: true, follow: true})
    borg.modem.demuxStream(stream, process.stdout, process.stderr)
    await borg.wait()
    await try_stop(borg)
  } finally {
    // Stop borg if it is still running but errored
    if (borg) await try_stop(borg)

    // Restart container if it was running before
    try {
      if (cont && infos && SHOULD_SHUTDOWN && CONT_WAS_RUNNING && !(await cont.inspect()).State.Running) {
        console.log(`Restarting ${infos.Name}`)
        await cont.start()
      }
    } catch { }
    if (borg)
      await borg.remove()
  }

}


async function run(contdesc: string, command: string, args: string[]) {
  var [contid, dir] = contdesc.split(':')
  const container = await d.getContainer(contid)
  const infos = await container.inspect()
  const labels = infos.Config.Labels

  const BASE_DIR = process.env.CHEST_BACKUPS_DIR || '/home/chest/backups/'

  // First try to see if the directory was specified in a label or in the command line.
  // the command line has priority
  dir = dir || labels['chest.name']

  // If it is absolute, keep as is.
  dir = dir && (dir[0] === '/' || dir[0] === '.') ? path.resolve(dir) :
    // otherwise, use the base directory.
    path.join(BASE_DIR, dir || infos.Name.replace(/^.*\//, ''))
  console.log(` => Using backup repository ${dir}`)

  const prefix = process.env.CHEST_PREFIX || labels['chest.prefix'] || 'chest'
  const passphrase = process.env.CHEST_PASSPHRASE || labels['borg.passphrase'] || ''

  if (command === 'borg') {
    await runBorgOnContainer(container, dir, 'borg ' + args.join(' ')).catch(e => console.error(e))
  } else if (command === 'backup') {
    const name = args[0] || [prefix, getTimestamp()].filter(q => q).join('-')

    var prune = process.env.BORG_PRUNE || labels['borg.prune']
    if (prune === 'auto')
      prune = '--keep-daily 7 --keep-weekly 2 --keep-monthly 1'
    else if (prune && !prune.includes('-')) // no real arguments to prune
      prune = ''

    // FIXME should prune on prefix only !
    await runBorgOnContainer(container, dir, `
      if grep repository %repo/config > /dev/null 2>&1 ; [ "$?" -ne 0 ]; then
        borg init -e ${passphrase ? "repokey-blake2" : "none"} %repo
      fi
      cd %data && borg create --stats "::${name}" ./*
      ${prune ? `
      echo
      echo " --- pruning --- "
      echo
      borg prune ${prune} -P "${prefix}" -s --list ::` : ''}
    `)
  } else if (command === 'list') {
    await runBorgOnContainer(container, dir, `borg list --format="{archive}{NL}" ::`)
  } else if (command === 'show') {
    await runBorgOnContainer(container, dir, `borg list --format="{mode}{TAB}{size}{TAB}{path}{NL}" ::${args[0]}`)
  } else if (command === 'restore') {
    await runBorgOnContainer(container, dir, `
    cd %data && borg extract --list -v "::${args[0]}"
  `)
  } else {
    usage()
  }
}

async function backupAll() {
  const all = await d.listContainers({all: true})
  for (var cont of all) {
    if (cont.Labels['chest.auto-backup']) {
      await run(cont.Id, 'backup', [])
    }
  }
}

function usage() {
  console.log(`usage:
  chest <container[:backupdir]> backup [backup-name]
    create a backup
  chest <container[:backupdir]> restore <backup-name>
    restore backup into the container
  chest <container[:backupdir]> list
    list a container backups' archives
  chest <container[:backupdir]> show [backup-name]
    list the files in an archive
  chest <container[:backupdir]> borg [borg commands...]
    execute a raw borg command. You may refer to the repository as '::' and
    to the data directory as %data.
  chest <relative or absolute path> <borg commands...>
    run borg commands on the given directory
  chest backup-all
    backup all containers that have the label chest.auto-backup

If backupdir is not specified, it becomes $HOME/.chest/backups/<container_name>
You may specify the "chest.name" label on the container, in which case it is used
instead of <container_name>. If it starts with /, then it is used as the directory.

Use the CHEST_BACKUPS_DIR environment variable to put the base backup directory
elsewhere than in $HOME/.chest/backups.

Env variables :
  * BORG_PASSPHRASE : Force the use of a passphrase
  * BORG_PRUNE : "auto" or flags for the prune command to use with backup
  * CHEST_BACKUPS_DIR : The root of all backups instead of $HOME/.chest/backups
  * CHEST_PREFIX : The prefix to use with backup

Usable labels on your containers:
  * chest.name : the directory name for the backup. Can be absolute or relative to
               CHEST_BACKUPS_DIR.
  * chest.prefix : The name of the prefix of the archives created with the backup
                  command. Defaults to "chest"
  * chest.auto-backup : any value will mark this container as backupable with the
                  chest backup-all command
  * chest.keep-running : do not shut down this container prior to backuping it.
                  warning : some containers may be backuped in an inconsistent
                  state with this option !

Borg specific options
  * borg.prune : "auto" or flags for the borg prune command. If specified, prune
                  will be run each time the container is backuped on all archives
                  with the same prefix.
  * borg.passphrase : a passphrase for the archive. If unspecified, the repository
                  will not be encrypted.

`)
  process.exit(1)
}

const [contdesc, command, ...args] = process.argv.slice(2)
if (!contdesc) {
  usage()
}

if (contdesc[0] === '.' || contdesc[0] === '/') {
  const stats = fs.statSync(contdesc)
  if (stats.isDirectory()) {
    runBorgOnContainer(null, path.resolve(contdesc), 'borg ' + args.join(' '))
  }
} else if (contdesc === 'backup-all') {
  backupAll().catch(e => console.error(e))
} else {
  run(contdesc, command, args).catch(e => console.error(e))
}