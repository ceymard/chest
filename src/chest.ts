#!/usr/bin/env node
import { Type, boolean, command, flag, option, optional, positional, run, string, subcommands } from "cmd-ts"
import * as api from "./api.js"
import * as _ch from "chalk"
import * as helpers from "./helper.js"
import "./monkey.js"

// const version = "0.1.0"

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

function P(name: string, description?: string) {
  return positional({
    description,
    displayName: name,
  })
}

function O(long: string, description?: string) {
  return option({long, short: long[0], description})
}

function Opt(long: string, description?: string) {
  return option({long, short: long[0], description, type: optional(string)})
}

function OptFlag(long: string, description?: string) {
  return flag({long, short: long[0], description, type: optional(boolean)})
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


const opt_repository_optional = option({
  long: "repository",
  short: "r",
  description: "a path to a repository if not inferring from labels",
  type: optional(string),
})

////////////////////////////////////////////////////


const cmd_container_backup = command({
  name: "backup",
  // version: version,
  description: "backup a container to a borg repository",
  args: {
    container: opt_container_required,
    archive: Opt("archive"),
    keep_running: OptFlag("keep-running", "keep the container running"),
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


export interface Args {
  repository?: string,
  archive?: string,
  passphrase?: string
  keep_running?: boolean,
}


async function get_compose(project_name: string, args: Args) {
  const containers = await api.docker.listContainers({
    filters: {
      label: [
      `com.docker.compose.project=${project_name}`
      ]
    }
  })

  if (!containers?.length) {
    return null
  }

  const defs = api.fill_defaults_from_container(containers , config)
  const repository = args.repository ?? defs.repository ?? path.join(defs.backups_compose_dir, project_name)
  const archive = args.archive ?? `${project_name}-${helpers.getTimestamp2()}`
  const prune = defs.prune
  const passphrase = args.passphrase ?? defs.passphrase

  return {project_name, containers, repository, archive, prune, passphrase, keep_running: !!args.keep_running}
}


const cmd_compose_backup = command({
  name: "compose-backup",
  // version,
  description: "backup a compose project",
  args: {
    project: P("project-name", "the compose project name"),
    archive: Opt("archive", "an archive name"),
    repository: Opt("repository", "a repository"),
    passphrase: Opt("passphrase", "a passphrase"),
    keep_running: OptFlag("keep-running", "keep the containers running instead of shutting them down")
  },
  handler: async args => {

    const opts = await get_compose(args.project, {
      ...args,
    })

    if (!opts) {
      throw new Error("project not found")
    }

    await api.do_project_backup({
      ...opts,
      config,
      user: config.user,
      group: config.group,
      stderr: helpers.stderr_progress,
    })
  }
})


const cmd_compose_list = command({
  name: "compose-backup",
  // version,
  description: "backup all compose projects marked for auto backup",
  args: {
    project: P("project", "the compose project name"),
    passphrase: Opt("passphrase", "a passphrase"),
    repository: Opt("repository", "a borg backup repository"),
  },
  handler: async args => {
    const opts = await get_compose(args.project, args)

    await api.run_borg_backup({
      ...opts,
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

const cmd_compose_backup_all = command({
  name: "compose-backup",
  // version,
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


const cmd_restore = command({
  name: "restore",
  description: "restore a container to a preceding backup",
  // version: version,
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


async function find_out_repository(def: string) {
  const test_project = await get_compose(def, {})
  let repository = def

  if (test_project?.containers.length) {
    return test_project.repository
  }

  const cnt = api.docker.getContainer(def)

  return repository
}


const cmd_list = command({
  name: "list",
  // version,
  description: "List archives in a repository or a container",
  args: {
    repository: P("repository", "a repo description"),
  },
  handler: async args => {
    let repository = await find_out_repository(args.repository)

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


const cmd_compose_extract = command({
  name: "extract-compose",
  // version,
  description: "extract docker-compose working directory from a backup",
  args: {
    repository_definition: P("repository", "a repository path, or a container with labels, or a project name"),
    archive: P("archive", "the archive name containing the wanted compose files"),
    passphrase: Opt("passphrase", "a passphrase")
  },
  handler: async args => {

    const repository = await find_out_repository(args.repository_definition)
    const archive = args.archive

    const binds = [
      `${process.cwd()}:/cwd:rw`,
    ]

    await api.run_borg_backup({
      command: api.command_tag`mkdir /cwd2 && cd /cwd2 && borg --show-version extract --noacls --noxattrs --progress --log-json --list -v --pattern=+__compose__ '--pattern=-**/*' "::${archive}" && chown ${config.user}:${config.group} /cwd2/* && cp -Rfp /cwd2/__compose__/* /cwd/ 2>/dev/null`,
      config,
      repository,
      passphrase: args.passphrase,
      binds,
    })

  }
})


const cmd_tar_backup = command({
  name: "tar-backup",
  // version,
  description: "restore a project from a tar archive",
  args: {
    project_name: P("project-name", "the compose project to restore"),
    archive: P("tar-archive", "the tar archive to write to"),
  },
  async handler(args) {
    const opts = await get_compose(args.project_name, args)
    if (!opts) {
      throw new Error("project not found")
    }

    helpers.touch(opts.archive)

    api.run_borg_backup_on_project({
      ...opts,
      config,
      binds: [
        `${args.archive}:/output.tar.xf:rw`,
      ],
      no_json: true,
      command: api.command_tag`
cd /data && tar cfp /output.tar.xf .
`
    })
  },
})


const cmd_tar_restore = command({
  name: "tar-restore",
  // version,
  description: "restore a project from a tar archive",
  args: {
    project_name: P("project-name", "the compose project to restore"),
    archive: P("tar-archive", "the archive to restore into the project"),
    passphrase: Opt("passphrase", "a passphrase"),
  },
  async handler(args) {
    const opts = await get_compose(args.project_name, args)
    if (!opts) {
      throw new Error("project not found")
    }
    api.do_project_restore_tar({
      ...opts,
      config,
    })
  },
})


const cmd_tar_export = command({
  name: "export-tar",
  // version,
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


const cmd_compose_restore = command({
  name: "compose-restore",
  // version,
  description: "restore a whole compose project",
  args: {
    project_name: P("project-name", "a compose project name"),
    repository: opt_repository_optional,
    archive: P("archive", "the archive name to restore to"),
    passphrase: Opt("passphrase", "a passphrase"),
  },
  handler: async args => {

    const opts = await get_compose(args.project_name, args)
    if (!opts) {
      throw new Error("project not found")
    }

    await api.do_project_restore({
      ...opts,
      config,
      stderr: helpers.stderr_progress,
    })
  }
})


const opts = subcommands({
  name: "chest",
  // version: version,
  cmds: {
    "backup-all": cmd_compose_backup_all,
    "backup": cmd_compose_backup,
    "list": cmd_compose_list,
    "restore": cmd_compose_restore,
    "extract-compose": cmd_compose_extract,
    "container-backup": cmd_container_backup,
    // "container-backup-all": cmd_backup_all,
    "container-restore": cmd_restore,
    "container-list": cmd_list,
    "tar-export": cmd_tar_export,
    "tar-backup": cmd_tar_backup,
    "tar-restore": cmd_tar_restore,
    // extract: cmd_extract
  },
})

run(opts, process.argv.slice(2))
