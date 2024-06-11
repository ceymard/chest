#!/usr/bin/env node
import { Type, command, flag, option, optional, run, string, subcommands } from "cmd-ts"
import * as api from "./api.js"
import * as _ch from "chalk"
import * as helpers from "./helper.js"
import "./monkey.js"

const version = "0.1.0"

import Dockerode from "dockerode"
import path from "path"

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


function O(long: string, description?: string) {
  return option({long, short: long[0], description})
}

function Opt(long: string, description?: string) {
  return option({long, short: long[0], description, type: optional(string)})
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


const opt_keep_running = flag({
  long: "keep-running",
  description: "do not stop the container from running",
  type: optional(map((opt: boolean) => {
    config.keep_running = opt
    return opt
  }))
})



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


const cmd_backup = command({
  name: "backup",
  version: version,
  description: "backup a container to a borg repository",
  args: {
    container: opt_container_required,
    archive: Opt("archive"),
    keep_running: opt_keep_running,
    repository: opt_repository_optional,
  },
  handler: async args => {

    const defs = api.fill_defaults_from_container(await args.container.inspect(), config)

    const repository = args.repository ?? defs.repository
    const archive = args.archive ?? defs.archive
    const prune = defs.prune

    await api.do_backup({
      binds: [],
      config,
      container: args.container,
      infos: await args.container.inspect(),
      repository,
      archive,
      prune,
      keep_running: args.keep_running,
      prefix: defs.prefix,
      user: config.user,
      group: config.group,
    })
  }
})


const cmd_backup_compose = command({
  name: "compose-backup",
  version,
  description: "backup a compose project",
  args: {
    project: O("project-name", "the compose project name"),
    archive: Opt("archive", "an archive name"),
    repository: Opt("repository", "a repository"),
    passphrase: Opt("passphrase", "a passphrase")
  },
  handler: async args => {

    const project_name = args.project
    const containers = await api.docker.listContainers({
      filters: {
        label: [
        `com.docker.compose.project=${args.project}`
        ]
      }
    })

    const defs = api.fill_defaults_from_container(containers , config)
    const repository = args.repository ?? path.join(defs.backups_compose_dir, project_name)
    const archive = args.archive ?? `${project_name}-${helpers.getTimestamp2()}`
    const prune = defs.prune

    await api.do_project_backup({
      project_name,
      containers,
      archive,
      prune,
      config,
      repository,
      passphrase: args.passphrase,
      user: config.user,
      group: config.group,
    })
  }
})

const cmd_compose_list = command({
  name: "compose-backup",
  version,
  description: "backup all compose projects marked for auto backup",
  args: {
    project: O("project", "the compose project name"),
    passphrase: Opt("passphrase", "a passphrase")
  },
  handler: async args => {
    const containers = await api.docker.listContainers({
      filters: {
        label: [`com.docker.compose.project=${args.project}`]
      }
    })

    const defs = api.fill_defaults_from_container(containers , config)
    const repository = defs.repository ?? path.join(defs.backups_compose_dir, args.project)

    await api.run_borg_backup({
      repository,
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

const cmd_backup_compose_all = command({
  name: "compose-backup",
  version,
  description: "backup all compose projects marked for auto backup",
  args: {
    passphrase: Opt("passphrase", "a passphrase")
  },
  handler: async args => {

    const all_containers = await api.docker.listContainers({
      filters: {
        label: [`com.docker.compose.project`]
      }
    })

    const group = Map.groupBy(all_containers, item => item.Labels["com.docker.compose.project"])

    for (const [project_name, containers] of group) {
      const labels = api.merge_labels(containers)

      if (!labels["chest.auto-backup"]) { continue }
      console.log(`${STAR} backuping ${ch.bold.bgCyanBright(project_name)}`)

      const defs = api.fill_defaults_from_container(containers , config)
      const repository = defs.repository ?? path.join(defs.backups_compose_dir, project_name)
      const archive = `${project_name}-${helpers.getTimestamp2()}`
      const prune = defs.prune
      const passphrase = args.passphrase ?? defs.passphrase

      await api.do_project_backup({
        project_name,
        containers,
        archive,
        prune,
        config,
        repository,
        passphrase,
        user: config.user,
        group: config.group,
      })
    }

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

        const prune = defs.prune

        await api.do_backup({
          container: c,
          config,
          infos,
          prune,
          repository: defs.repository,
          archive: defs.archive,
          prefix: defs.prefix,
          user: config.user,
          group: config.group,
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
      command: api.command_tag`mkdir /cwd2 && cd /cwd2 && borg --show-version extract --noacls --noxattrs --progress --log-json --list -v '--pattern=+*.yml' '--pattern=-**/*' "::${args.archive}" && chown ${config.user}:${config.group} /cwd2/* && cp -p /cwd2/* /cwd/`,
      config,
      repository,
      binds,
    })

  }
})


const cmd_restore_tar = command({
  name: "restore-tar",
  version,
  description: "restore a compose project from a tar archive",
  args: {
    project: O("project"),
    output: O("output"),
  },
  handler: async args => {

  }
})



const cmd_export_tar = command({
  name: "export-tar",
  version,
  description: "export a borg archive to a tarball",
  args: {
    respository: O("repository"),
    archive: O("archive"),
    output: O("output"),
  },
  handler: async args => {
    api.do_export_tar({
      archive: args.archive,
      config,
      repository: args.respository,
      tarpath: args.output,
    })
  },
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
    container: opt_container_optional,
  },
  handler: async args => {

    const repository = args.repository
    let working_directory = process.cwd()

    if (args.container) {
      const infos = await args.container.inspect()
      working_directory = infos.Config.Labels["com.docker.compose.project.working_dir"]
    }

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
    "compose-backup-all": cmd_backup_compose_all,
    "compose-extract": cmd_extract_compose,
    "compose-backup": cmd_backup_compose,
    "compose-list": cmd_compose_list,
    restore: cmd_restore,
    list: cmd_list,
    "restore-compose": cmd_restore_compose,
    "tar-export": cmd_export_tar,
    "tar-restore": cmd_restore_tar,
    // extract: cmd_extract
  },
})

run(opts, process.argv.slice(2))
