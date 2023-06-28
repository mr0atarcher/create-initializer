const chalk = require('chalk')
const { CommonSpawnOptions } = require('child_process')
const { spawn } = require('cross-spawn')
const execa = require('execa')
const fs = require('fs/promises')
const gitconfig = require('gitconfig')
const { availableLicenses, makeLicenseSync } = require('license.js')
const path = require('path')
const yargsInteractive = require('yargs-interactive')
const { copy, getAvailableTemplates } = require('./template.js')

const { CommonOptions, ExecaChildProcess } = execa
const { OptionData } = yargsInteractive

async function getGitUser() {
	try {
		const config = await gitconfig.get({ location: 'global' })
		return config.user || {}
	} catch (err) {
		return {}
	}
}

function spawnPromise(
	command,
	args = [],
	options = {}
) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'inherit', ...options })
		child.on('close', (code) => {
			if (code !== 0) {
				return reject(code)
			}
			resolve(code)
		})
	})
}

async function installDeps(rootDir, useYarn) {
	let command
	let args
	if (useYarn) {
		command = 'yarnpkg'
		args = ['install', '--cwd', rootDir]
	} else {
		command = 'npm'
		args = ['install']
		process.chdir(rootDir)
	}
	try {
		await spawnPromise(command, args, { stdio: 'inherit' })
	} catch (err) {
		throw new Error(`installDeps failed: ${err}`)
	}
}

async function IsYarnAvailable() {
	try {
		await execa('yarnpkg', ['--version'])
		return true
	} catch (e) {
		return false
	}
}

async function exists(filePath, baseDir = '/') {
	try {
		await fs.stat(path.resolve(baseDir, filePath))
	} catch (err) {
		if (err.code === 'ENOENT') return false
		else throw err
	}

	return true
}

async function initGit(root) {
	await execa('git init', { shell: true, cwd: root })
}

function getContact(author, email) {
	return `${author}${email ? ` <${email}>` : ''}`
}

async function isEmptyDir(dirname) {
	try {
		return (
			(await fs.readdir(dirname)).length === 0
		)
	} catch (err) {
		if (err.code === 'ENOENT') {
			return true
		}
		throw err
	}
}

async function getYargsOptions(
	templateRoot,
	templatePrefix,
	promptForTemplate,
	defaultTemplate,
	skipLicense = false,
	extraOptions = {}
) {
	const gitUser = await getGitUser()
	const availableTemplates = await getAvailableTemplates(templateRoot, templatePrefix)
	const isMultipleTemplates = availableTemplates.length > 1
	const askForTemplate = isMultipleTemplates && promptForTemplate
	const yargOption = {
		interactive: { default: true },
		description: {
			type: 'input',
			describe: 'description',
			default: 'description',
			prompt: skipLicense ? 'never' : 'if-no-arg',
		},
		author: {
			type: 'input',
			describe: 'author name',
			default: gitUser.name,
			prompt: skipLicense ? 'never' : 'if-no-arg',
		},
		email: {
			type: 'input',
			describe: 'author email',
			default: gitUser.email,
			prompt: skipLicense ? 'never' : 'if-no-arg',
		},
		template: {
			type: 'list',
			describe: 'template',
			default: defaultTemplate,
			prompt: askForTemplate ? 'if-no-arg' : 'never',
			choices: availableTemplates,
		},
		license: {
			type: 'list',
			describe: 'license',
			choices: [...availableLicenses(), 'UNLICENSED'],
			prompt: skipLicense ? 'never' : 'if-no-arg',
		},
		...extraOptions,
	}
	return yargOption
}

async function create(appName, options) {
	const firstArg = process.argv[2]
	if (typeof firstArg === 'undefined') {
		return console.log(`Usage: ${appName} <project_name> [args]`)
	}

	const useCurrentDir = firstArg === '.'
	const name = useCurrentDir
		? path.basename(process.cwd())
		: options.modifyName
			? await Promise.resolve(options.modifyName(firstArg))
			: firstArg
	const projectDir = useCurrentDir
		? process.cwd()
		: options.defaultPath
			? path.resolve(`${options.defaultPath}/${name}`)
			: path.resolve(name)

	console.log(`\nNew project will be created in ${chalk.green(projectDir)}.\n`)

	if (!(await isEmptyDir(projectDir))) {
		throw new Error(`${projectDir} is not empty.`)
	}

	const { templateRoot, templatePrefix = '', promptForTemplate = false, defaultTemplate = 'default' } = options
	const yargsOption = await getYargsOptions(
		templateRoot,
		templatePrefix,
		promptForTemplate,
		defaultTemplate,
		true,
		options.extra
	)
	const args = await yargsInteractive()
		.usage('$0 <project_name> [args]')
		.interactive(yargsOption)

	const template = args.template
	const templateDir = path.resolve(templateRoot, `${templatePrefix}${template}`)
	const year = new Date().getFullYear()
	const contact = getContact(args.author, args.email)

	if (!(await exists(templateDir))) {
		throw new Error('No template found')
	}

	const filteredArgs = Object.entries(args)
		.filter(
			(arg) =>
				arg[0].match(/^[^$_]/) && !['interactive', 'template'].includes(arg[0])
		)
		.reduce(
			(sum, cur) => ((sum[cur[0]] = cur[1]), sum),
			{}
		)

	const view = {
		...filteredArgs,
		name,
		year,
		contact,
	}

	// copy files from template
	console.log(`\nCreating a new project in ${chalk.green(projectDir)}.\n`)
	await copy({
		projectDir,
		templateDir,
		view,
	})

	if (!options.skipLicense) {
		// create LICENSE
		try {
			const license = makeLicenseSync(args.license, {
				year,
				project: name,
				description: args.description,
				organization: getContact(args.author, args.email),
			})
			const licenseText = `${license.header && license.header || ''}${license.text}${license.warranty && license.warranty || ''}`
			await fs.writeFile(path.resolve(projectDir, 'LICENSE'), licenseText)
		} catch (e) {
			// do not generate LICENSE
		}
	}

	// install dependencies using yarn / npm
	const useYarn = await IsYarnAvailable()
	if (await exists('package.json', projectDir)) {
		console.log(`Installing dependencies.`)
		await installDeps(projectDir, useYarn)
	}

	if (!options.skipGit) {
		// init git
		try {
			await initGit(projectDir)
			console.log('\nInitialized a git repository')
		} catch (err) {
			if (err.exitCode == 127) return // no git available
			throw err
		}
	}

	const run = (command, options = {}) => {
		const args = command.split(' ')
		return execa(args[0], args.slice(1), {
			stdio: 'inherit',
			cwd: projectDir,
			...options,
		})
	}

	const installNpmPackage = (packageName) => {
		return new Promise((resolve, reject) => {
			let command
			let args
			if (useYarn) {
				command = 'yarnpkg'
				args = ['--cwd', projectDir, 'add', packageName]
			} else {
				command = 'npm'
				args = ['install', '-D', packageName]
				process.chdir(projectDir)
			}
			const child = spawn(command, args, { stdio: 'inherit' })
			child.on('close', (code) => {
				if (code !== 0) {
					return reject(`installDeps failed: ${command} ${args.join(' ')}`)
				}
				resolve()
			})
		})
	}

	const afterHookOptions = {
		name,
		projectDir,
		template,
		templateDir,
		year,
		run,
		installNpmPackage,
		answers: {
			...filteredArgs,
			contact,
		},
	}

	// after hook script
	if (options.after) {
		await Promise.resolve(options.after(afterHookOptions))
	}

	console.log(`\nSuccess! Created ${chalk.bold.cyan(name)}.`)

	if (options.caveat) {
		switch (typeof options.caveat) {
			case 'string':
				console.log(options.caveat)
				break
			case 'function':
				const response = await Promise.resolve(
					options.caveat(afterHookOptions)
				)
				if (response) {
					console.log(response)
				}
				break
			default:
		}
	}
}

module.exports = { create }
