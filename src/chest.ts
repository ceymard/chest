#!/usr/bin/env node
import { version } from "../package.json"
import { Type, command, flag, option, optional, run, string, subcommands } from "cmd-ts"
import * as api from "./api"
import * as _ch from "chalk"
import * as helpers from "./helper"

import Dockerode from "dockerode"

const ch = new _ch.Chalk()
const STAR = ch.greenBright(" *")


const ContainerOption: Type<string, Dockerode.Container> = {
  async from(input: string) {
    return api.docker.getContainer(input.replace(/^\//, "").replace(/\.docker$/, ""))
  }
}

function map<R = string, T = R>(fn: (val: T) => R): Type<T, R> {
  return {
    async from(input: T) {
      return fn(input)
    }
  }
}


const config = api.read_config()


const opt_container_required = option({
  description: "a container name",
  short: "c",
  long: "container",
  type: ContainerOption,
})


const opt_container_optional = option({
  description: "a container name",
  short: "c",
  long: "container",
  type: optional(ContainerOption),
})


const archive = option({
  long: "archive",
  short: "a",
  description: "an archive name",
})


const opt_keep_running = flag({
  long: "keep-running",
  description: "do not stop the container from running",
  type: optional(map((opt: boolean) => {
    config.keep_running = opt
    return opt
  }))
})



const opt_archive_optional = option({
  long: "archive",
  short: "a",
  description: "an archive name (use <chest list> to list them)",
  type: optional(string),
})


// function autoRepository(cont: api.RuntimeInfos) {
//   return cont.chest.repository ?? `${BACKUPS_DIR}/${cont.chest.name}`
// }

const opt_repository = option({
  long: "repository",
  short: "r",
  description: "a path to a repository if not inferring from labels",
})


const opt_repository_optional = option({
  long: "repository",
  short: "r",
  description: "a path to a repository if not inferring from labels",
  type: optional(string),
})

////////////////////////////////////////////////////


// const cmd_extract = command({
//   name: "extract",
//   description: "extract data from a backup",
//   version,
//   args: {
//     archive,
//     output_directory: option({
//       long: "output",
//       short: "o",
//       description: "the directory where to output the extract",
//     })
//   },
//   handler: args => {

//   },
// })



const cmd_backup = command({
  name: "backup",
  version: version,
  description: "backup a container to a borg repository",
  args: {
    container: opt_container_required,
    archive: opt_archive_optional,
    keep_running: opt_keep_running,
    repository: opt_repository_optional,
  },
  handler: async args => {

    const defs = api.fill_defaults_from_container(await args.container.inspect(), config)

    const repository = args.repository ?? defs.repository
    const archive = args.archive ?? defs.archive

    await api.do_backup({
      binds: [],
      config,
      container: args.container,
      infos: await args.container.inspect(),
      repository,
      archive,
      keep_running: args.keep_running,
      prefix: defs.prefix,
      user: config.user,
      group: config.user,
    })
  }
})


const cmd_backup_all = command({
  name: "backup-all",
  description: "backup all containers that have chest.auto-backup labels set",
  version: version,
  args: { },
  handler: async args => {

    const all = await api.docker.listContainers({all: true})
    for (var cont of all) {
      if (cont.Labels['chest.auto-backup']) {
        console.log(ch.greenBright(" ***"), "backuping", ch.bold.yellowBright(cont.Names[0]))

        const c = api.docker.getContainer(cont.Id)
        const infos = await c.inspect()
        const defs = api.fill_defaults_from_container(infos, config)
        await api.do_backup({
          container: c,
          config,
          infos,
          repository: defs.repository,
          archive: defs.archive,
          prefix: defs.prefix,
          user: config.user,
          group: config.user,
        })
      }
    }
  }
})


const cmd_restore = command({
  name: "restore",
  description: "restore a container to a preceding backup",
  version: version,
  args: {
    container: opt_container_required,
    repository: opt_repository_optional,
    archive: option({
      description: "the archive name",
      short: "a",
      long: "archive"
      // displayName: "archive",
    })
  },
  handler: async args => {
    const infos = await args.container.inspect()
    const defs = api.fill_defaults_from_container(infos, config)

    await api.do_restore({
      container: args.container,
      infos: await args.container.inspect(),
      archive: args.archive,
      config,
      repository: args.repository ?? defs.repository,
    })
  }
})


const cmd_list = command({
  name: "list",
  version,
  description: "List archives in a repository or a container",
  args: {
    container: opt_container_optional,
    repository: opt_repository_optional,
  },
  handler: async args => {
    let repository = args.repository

    if (args.container && !repository) {
      const defs = api.fill_defaults_from_container(await args.container.inspect(), config)
      repository = defs.repository
    }

    if (!repository) {
      console.error(`please give a container or a valid repository to list`)
      return
    }

    await api.run_borg_backup({
      repository: repository,
      config,
      command: api.command_tag`borg list --json --log-json --format="{archive}{NL}" ::`,
      stdout(data, id) {
        for (const arch of data.archives) {
          console.log(STAR, arch.name, ch.grey(arch.time))
        }
      },
    })
  }
})


const cmd_extract_compose = command({
  name: "extract-compose",
  version,
  description: "extract compose files from a backup",
  args: {
    repository: opt_repository,
    container: opt_container_optional,
    archive: option({
      long: "archive",
      short: "a",
      description: "the archive to get the docker-compose.yml from",
    }),
  },
  handler: async args => {

    let repository = args.repository

    if (!repository && args.container) {
      const infos = await args.container.inspect()
      const defs = api.fill_defaults_from_container(infos, config)
      repository = defs.repository
    }

    const binds = [
      `${process.cwd()}:/cwd:rw`,
    ]

    await api.run_borg_backup({
      command: api.command_tag`mkdir /cwd2 && cd /cwd2 && borg --show-version extract --noacls --noxattrs --progress --log-json --list -v '--pattern=+*.yml' '--pattern=-**/*' "::${args.archive}" && chown ${config.user}:${config.user} /cwd2/* && cp -p /cwd2/* /cwd/`,
      config,
      repository,
      binds,
    })

  }
})


const cmd_restore_compose = command({
  name: "ressucitate",
  version,
  description: "restore a whole compose project",
  args: {
    repository: option({
      long: "repository",
      short: "r",
      description: "a repository"
    }),
    container: opt_container_required,
  },
  handler: async args => {

    const infos = await args.container.inspect()
    const repository = args.repository
    // const

    const working_directory = infos.Config.Labels["com.docker.compose.project.working_dir"]

    // Start by finding all containers matching the same compose project
    const all = (await api.docker.listContainers({all: true}))
      .filter(cont => cont.Labels["com.docker.compose.project.working_dir"] === working_directory)

    // All found archives.
    const archives: {name: string, time: string}[] = []

    console.log(STAR, "listing archives from repository")
    await api.run_borg_backup({
      command: `borg list --json --log-json --format="{archive}{NL}" ::`,
      repository,
      config,
      stdout(out, id) {
        for (const arch of out.archives) {
          archives.push({name: arch.name, time: arch.time})
          console.log(STAR, arch.name, ch.grey(arch.time))
        }
      },
    })

    // Sort the archives so that the most recent ones come first
    archives.sort((a, b) => -a.time.localeCompare(b.time))

    const todo: {container: Dockerode.Container, infos: Dockerode.ContainerInspectInfo, archive: string}[] = []

    for (let inf of all) {
      const container = await api.docker.getContainer(inf.Id)
      const infos = await container.inspect()

      const defs = api.fill_defaults_from_container(infos, config)
      const pref = defs.prefix
      const my_archive = archives.filter(ar => ar.name.startsWith(pref + "-"))[0]
      if (my_archive) {
        todo.push({
          container,
          infos,
          archive: my_archive.name
        })
      }
    }

    if (todo.length === 0) {
      console.log(ch.redBright("there is nothing to restore, exiting."))
      return
    }

    console.log(ch.yellowBright(" !! ") + "the following will happen :")
    for (let td of todo) {
      console.log(`${ch.yellowBright(" - ")} restore ${td.archive} into ${td.infos.Name}`)
    }
    const ans = await helpers.question("continue ? y/[n] ")

    if (ans.toLowerCase() !== "y") {
      console.log("exiting")
      return
    }

    for (let td of todo) {
      await api.do_restore({
        container: td.container,
        infos: td.infos,
        archive: td.archive,
        repository,
        config,
      })
    }
  }
})


const opts = subcommands({
  name: "chest",
  version: version,
  cmds: {
    backup: cmd_backup,
    "backup-all": cmd_backup_all,
    "extract-compose": cmd_extract_compose,
    restore: cmd_restore,
    list: cmd_list,
    "restore-compose": cmd_restore_compose,
    // extract: cmd_extract
  },
})

run(opts, process.argv.slice(2))
