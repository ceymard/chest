import Docker, { Container, ContainerInspectInfo } from "dockerode"
import path from "path"
import * as _ch from "chalk"
import * as es from "event-stream"
import * as os from "os"
import parser from "stream-json"
import StreamValues from "stream-json/streamers/StreamValues"

const ch = new _ch.Chalk()

export const docker = new Docker()
const BORG_IMAGE = 'ceymard/borg:1.2.8'

let cleanup: null | (() => any) = null


export interface RuntimeInfos {
  container?: Container
  infos?: ContainerInspectInfo
  labels?: {
    [label: string]: string;
  }
  /** the binds that we'll need afterward */
  binds: string[]

  chest: {
    archive?: string
    backups_dir?: string
    name?: string
    prefix?: string
    repository?: string
    prune?: string
    auto?: boolean
    passphrase?: string
    keep_running?: boolean
    auto_backup?: boolean
    uid?: number
    gid?: number
  }

  compose: {
    workding_dir?: string
    config_files?: string[]
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

/**
 * Run the given command in the container.
 * @param cont the container
 * @param repo the directory of the repository
 */
export async function runBorg(
  cont: RuntimeInfos,
  args: string,
  stdout?: (data: any, id: number) => any,
  stderr?: (data: any, id: number) => any,
) {


  if (!cont.chest.repository) {
    throw new Error("no repository")
  }

  const infos = cont.infos
  const container_was_running = !!infos?.State.Running
  const labels = cont.labels

  const repository = cont.chest.repository
  const repo_is_ssh = repository.includes("@")

  // Get the volumes of our container and mount them in /data
  const binds: string[] = cont.binds

  // A series of basic binds that we need
  binds.push('/etc/hosts:/etc/hosts:ro')
  binds.push('/etc/localtime:/etc/localtime:ro')
  binds.push('/etc/timezone:/etc/timezone:ro')

  // binds.push(`${process.cwd()}:/cwd:rw`)

  // A few environment variables needed for chest to work
  const env = [
    "BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=yes",
    "BORG_RELOCATED_REPO_ACCESS_IS_OK=yes",
    "BORG_HOSTNAME_IS_UNIQUE=no",
    `BORG_REPO=${repo_is_ssh ? repository : "/repository"}`,
  ]

  if (!repo_is_ssh) {
    binds.push(`${cont.chest.repository}:/repository:rw`)
  } else if (process.env["SSH_AUTH_SOCK"]) {

    binds.push(`${process.env["SSH_AUTH_SOCK"]}:${process.env["SSH_AUTH_SOCK"]}`)
    binds.push(`${os.homedir()}/.ssh:/ssh:ro`)
    env.push(`SSH_AUTH_SOCK=${process.env["SSH_AUTH_SOCK"]}`)
    args = `
    mkdir /root/.ssh ; cp -Rf /ssh/* /root/.ssh/
    ${args}
    `
  }

  const passphrase = process.env.BORG_PASSPHRASE || labels?.['borg.passphrase'] || ''
  if (passphrase) {
    env.push(`BORG_PASSPHRASE=${passphrase}`)
  }

  let shutdown_container = false
  if (!cont.chest.keep_running) {
    shutdown_container = true
  }

  // Add docker-compose.yml to the back-ups if the container is part of a compose file
  if (cont.compose.config_files) {
    binds.push(
      ...cont.compose.config_files.map(c => `${c}:/data/${path.basename(c)}:ro`)
    )
  }

  let borg: Docker.Container | undefined

  const try_stop = async (container: Docker.Container) => {
    const running = (await container.inspect()).State.Running
    if (running)
      await container.stop({  })
    return running
  }

  if (cont.chest.uid && !repo_is_ssh) {
    args += `\nchown -R ${cont.chest.uid}:${cont.chest.gid} /repository/*\n`
  }

  try {

    if (cont && cont.container && infos && infos.State.Running && shutdown_container) {
      console.log(` ${ch.redBright("⏸︎")} stopping ${infos.Name}`)
      await try_stop(cont.container)
      // Let's give ourselves some time.
      await new Promise(ac => setTimeout(ac, 5000))
    }

    cleanup = async () => {
      if (borg) await try_stop(borg)

      // Restart container if it was running before
      try {
        if (cont && cont.container && infos && shutdown_container && container_was_running && !(await cont.container.inspect()).State.Running) {
          console.log(` ${ch.greenBright("⏵︎")} restarting ${infos.Name}`)
          await cont.container.start()
        }
      } catch { }
      if (borg)
        await borg.remove()
    }

    borg = await docker.createContainer({
      Image: BORG_IMAGE,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: binds
      },
      WorkingDir: '/data',
      Entrypoint: '/bin/ash',
      Env: env,
      Cmd: ['-c', args]
    })

    await borg.start();
    const stream = await borg.logs({stdout: true, stderr: true, follow: true})


    const _stdout2 = es.pipeline(
      parser({ jsonStreaming: true }),
      new StreamValues(),
      es.mapSync((data: any) => {
        stdout?.(data.value, data.key)
        return data
      })
    )

    const _stderr2 = es.pipeline(
      parser({ jsonStreaming: true }),
      new StreamValues(),
      es.mapSync((data: any) => {
        const value = data.value
        if (
          value.type !== "question_prompt"
        && value.type !== "question_env_answer"
      ) {
          if (value.type === "log_message") {
            if (value.levelname === "ERROR" && value.msgid !== "Repository.AlreadyExists") {
              console.error(ch.redBright(" ⚠"), value.message)
            } else if (value.levelname === "WARNING") {
              console.error(ch.yellowBright(" ⚠"), value.message)
            }
          }
          stderr?.(value, data.key)
          // console.error(value)
        }

        return data
      })
    )

    borg.modem.demuxStream(stream, _stdout2, _stderr2)
    // borg.modem.demuxStream(stream, process.stdout, process.stderr)

    await borg.wait()
    await try_stop(borg)
  } finally {
    // Stop borg if it is still running but errored
    await cleanup?.()
    cleanup = null
  }

}


export async function getContainerDescription(input: string) {

  const container = await docker.getContainer(input.replace(/\.docker$/, ""))
    const infos = await container.inspect()
    const labels = infos.Config.Labels ?? {}
    const binds = infos.Mounts.map(m => `${m.Source}:${path.join(`/data`, m.Destination)}:rw`)

    const chest: RuntimeInfos["chest"] = {
      name: labels["chest.name"] ?? labels["com.docker.compose.project"],
      prefix: labels["chest.prefix"] ?? labels["com.docker.compose.service"] ?? process.env["CHEST_PREFIX"],
      prune: labels["borg.prune"] ?? process.env["BORG_PRUNE"],
      passphrase: labels["borg.passphrase"] ?? labels["chest.passphrase"] ?? process.env["CHEST_PASSPHRASE"] ?? process.env["BORG_PASSPHRASE"],
      keep_running: !!labels["chest.keep-running"] || !!process.env["CHEST_KEEP_RUNNING"],
      repository: labels["chest.repository"] ?? process.env["CHEST_REPOSITORY"],
    }

    const compose: RuntimeInfos["compose"] = {
      workding_dir: labels["com.docker.compose.project.working_dir"],
      config_files: labels["com.docker.compose.project.config_files"]?.split(/,/g)
    }

    const result: RuntimeInfos = {container, infos, labels, binds, chest, compose}

    return result
}

process.on("uncaughtException", function (err) {
  console.error(err)
  cleanup?.()
})