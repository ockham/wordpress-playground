// import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { startServer } from './server';
import {
	PHPRequest,
	PHPRequestHandler,
	PHPResponse,
	SupportedPHPVersion,
	SupportedPHPVersions,
	__private__dont__use,
} from '@php-wasm/universal';
import { logger } from '@php-wasm/logger';
import { createPhp } from './setup-php';
import { setupWordPress } from './setup-wp';
import {
	Blueprint,
	compileBlueprint,
	defineSiteUrl,
	runBlueprintSteps,
} from '@wp-playground/blueprints';
import { NodePHP } from '@php-wasm/node';
import { isValidWordPressSlug } from './is-valid-wordpress-slug';
import { EmscriptenDownloadMonitor, ProgressTracker } from '@php-wasm/progress';
import { RecommendedPHPVersion } from '@wp-playground/wordpress';
import { configure, InMemory, fs, Overlay } from '@zenfs/core';
import { Zip } from '@zenfs/zip';
import nodefs from 'fs';
import EmscriptenFS from './emsc';
import { NodeFs } from './nodefs';

export interface Mount {
	hostPath: string;
	vfsPath: string;
}

async function run() {
	/**
	 * @TODO This looks similar to Query API args https://wordpress.github.io/wordpress-playground/query-api
	 *       Perhaps the two could be handled by the same code?
	 */
	const yargsObject = await yargs(process.argv.slice(2))
		.usage('Usage: wp-playground <command> [options]')
		.positional('command', {
			describe: 'Command to run',
			type: 'string',
			choices: ['server', 'run-blueprint', 'build-snapshot'],
		})
		.option('outfile', {
			describe: 'When building, write to this output file.',
			type: 'string',
			default: 'wordpress.zip',
		})
		.option('port', {
			describe: 'Port to listen on when serving.',
			type: 'number',
			default: 9400,
		})
		.option('php', {
			describe: 'PHP version to use.',
			type: 'string',
			default: RecommendedPHPVersion,
			choices: SupportedPHPVersions,
		})
		.option('wp', {
			describe: 'WordPress version to use.',
			type: 'string',
			default: 'latest',
		})
		// @TODO: Support read-only mounts, e.g. via WORKERFS, a custom ReadOnlyNODEFS, or by copying the files into MEMFS
		.option('mount', {
			describe:
				'Mount a directory to the PHP runtime. You can provide --mount multiple times. Format: /host/path:/vfs/path',
			type: 'array',
			string: true,
		})
		.option('login', {
			describe: 'Should log the user in',
			type: 'boolean',
			default: false,
		})
		.option('blueprint', {
			describe: 'Blueprint to execute.',
			type: 'string',
		})
		.option('skipWordPressSetup', {
			describe:
				'Do not download, unzip, and install WordPress. Useful for mounting a pre-configured WordPress directory at /wordpress.',
			type: 'boolean',
			default: false,
		})
		.option('quiet', {
			describe: 'Do not output logs and progress messages.',
			type: 'boolean',
			default: false,
		})
		.check((args) => {
			if (args.wp !== undefined && !isValidWordPressSlug(args.wp)) {
				throw new Error(
					'Unrecognized WordPress version. Please use "latest" or numeric versions such as "6.2", "6.0.1", "6.2-beta1", or "6.2-RC1"'
				);
			}
			if (args.blueprint !== undefined) {
				const blueprintPath = path.resolve(
					process.cwd(),
					args.blueprint
				);
				if (!fs.existsSync(blueprintPath)) {
					throw new Error('Blueprint file does not exist');
				}

				const content = fs.readFileSync(blueprintPath, 'utf-8');
				try {
					args.blueprint = JSON.parse(content);
				} catch (e) {
					throw new Error('Blueprint file is not a valid JSON file');
				}
			}
			return true;
		});

	yargsObject.wrap(yargsObject.terminalWidth());
	const args = await yargsObject.argv;

	if (args.quiet) {
		// @ts-ignore
		logger.handlers = [];
	}

	/**
	 * TODO: This exact feature will be provided in the PHP Blueprints library.
	 *       Let's use it when it ships. Let's also use it in the web Playground app.
	 */
	async function zipSite(outfile: string) {
		// Fake URL for the build
		const { php, reap } =
			await requestHandler.processManager.acquirePHPInstance();
		try {
			await php.run({
				code: `<?php 
				$zip = new ZipArchive();
				if(false === $zip->open('/tmp/build.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE)) {
					throw new Exception('Failed to create ZIP');
				}
				$files = new RecursiveIteratorIterator(
					new RecursiveDirectoryIterator('/wordpress')
				);
				foreach ($files as $file) {
					echo $file . PHP_EOL;
					if (!$file->isFile()) {
						continue;
					}
					$zip->addFile($file->getPathname(), $file->getPathname());
				}
				$zip->close();
				
			`,
			});
			const zip = php.readFileAsBuffer('/tmp/build.zip');
			fs.writeFileSync(outfile, zip);
		} finally {
			reap();
		}
	}

	async function prepareSite(
		php: NodePHP,
		wpVersion: string,
		siteUrl: string
	) {
		// No need to unzip WordPress if it's already mounted at /wordpress
		if (!args.skipWordPressSetup) {
			logger.log(`Setting up WordPress ${wpVersion}`);
			// @TODO: Rename to FetchProgressMonitor. There's nothing Emscripten about that class anymore.
			const monitor = new EmscriptenDownloadMonitor();
			monitor.addEventListener('progress', ((
				e: CustomEvent<ProgressEvent & { finished: boolean }>
			) => {
				// @TODO Every progres bar will want percentages. The
				//       download monitor should just provide that.
				const percentProgress = Math.round(
					Math.min(100, (100 * e.detail.loaded) / e.detail.total)
				);
				if (!args.quiet) {
					process.stdout.write(
						`\rDownloading WordPress ${percentProgress}%...    `
					);
				}
			}) as any);
			await setupWordPress(php, wpVersion, monitor);
		}

		// const mounts: Mount[] = (args.mount || []).map((mount) => {
		// 	const [source, vfsPath] = mount.split(':');
		// 	return {
		// 		hostPath: path.resolve(process.cwd(), source),
		// 		vfsPath,
		// 	};
		// });
		// for (const mount of mounts) {
		// 	php.mount(mount.hostPath, mount.vfsPath);
		// }

		// const writableFs = InMemory.create({ name: 'yay' });
		const nodeFs = NodeFs.create({
			name: 'yay',
			root: __dirname + '/root',
		});
		const originalCreateFileSync = nodeFs.createFileSync;
		nodeFs.createFileSync = function (path, flag, mode, cred) {
			const parentDir = path.split('/').slice(0, -1).join('/');
			if (!nodeFs.existsSync(parentDir, cred)) {
				nodeFs.mkdirSync(parentDir, 0o777, cred);
			}
			return originalCreateFileSync.call(this, path, flag, mode, cred);
		};

		const inMemoryFs = InMemory.create({ name: 'yay' });
		inMemoryFs.mkdirSync('/wordpress', 0o777, 0);
		inMemoryFs.createFileSync('/wordpress/virtual.txt', 'w', 0o777, 0);
		const handle = inMemoryFs.openFileSync(
			'/wordpress/virtual.txt',
			'w',
			0o777,
			0
		);
		handle.writeSync(new TextEncoder().encode('test'), 0, 'test'.length, 0);
		handle.closeSync();

		// const zipData = nodefs.readFileSync('testfs/test.zip').buffer;
		// const zipfs = Zip.create({ zipData });

		await configure({
			'/': Overlay.create({
				readable: nodeFs,
				writable: inMemoryFs,
			}).fs,
		});
		// await configure({
		// 	'/': inMemoryFs
		// });
		// await zipfs.ready();

		console.log(fs.readdirSync('/'));
		console.log(fs.readdirSync('/wordpress'));
		console.log(fs.readFileSync('/wordpress/virtual.txt'));

		console.log(fs.writeFileSync('/wordpress/virtual2.txt', 'test'));
		console.log(fs.readFileSync('/wordpress/virtual2.txt'));

		const BFS = new EmscriptenFS(
			php[__private__dont__use].FS,
			php[__private__dont__use].PATH,
			php[__private__dont__use].ERRNO_CODES
		);
		php.mkdir('/wordpress');
		php.mount('/wordpress', '/wordpress', BFS);
		// console.log(php.writeFile('/wordpress/hi.txt', 'a'));
		// console.log(fs.readFileSync('/wordpress/hi.txt'));
		console.log(php.listFiles('/wordpress'));
		console.log(php.readFileAsBuffer('/wordpress/virtual.txt'));
		console.log(php.readFileAsBuffer('/wordpress/virtual2.txt'));
		console.log(php.readFileAsBuffer('/wordpress/host.txt'));
		// console.log(php.readFileAsText('/wordpress/zipdir/noop.ts'));
		process.exit(0);
		fs.writeFileSync('/wordpress/newfile.txt', 'hello world');
		console.log(fs.readdirSync('/wordpress'));
		console.log(
			new TextDecoder().decode(fs.readFileSync('/zipdir/noop.ts'))
		);
		console.log(
			new TextDecoder().decode(fs.readFileSync('/zipdir/newfile.txt'))
		);

		await defineSiteUrl(php, {
			siteUrl,
		});
	}

	function compileInputBlueprint() {
		/**
		 * @TODO This looks similar to the resolveBlueprint() call in the website package:
		 * 	     https://github.com/WordPress/wordpress-playground/blob/ce586059e5885d185376184fdd2f52335cca32b0/packages/playground/website/src/main.tsx#L41
		 *
		 * 		 Also the Blueprint Builder tool does something similar.
		 *       Perhaps all these cases could be handled by the same function?
		 */
		let blueprint: Blueprint | undefined;
		if (args.blueprint) {
			blueprint = args.blueprint as Blueprint;
		} else {
			blueprint = {
				preferredVersions: {
					php: args.php as SupportedPHPVersion,
					wp: args.wp,
				},
				login: args.login,
			};
		}

		const tracker = new ProgressTracker();
		let lastCaption = '';
		let progress100 = false;
		tracker.addEventListener('progress', (e: any) => {
			if (progress100) {
				return;
			} else if (e.detail.progress === 100) {
				progress100 = true;
			}
			lastCaption =
				e.detail.caption || lastCaption || 'Running the Blueprint';
			process.stdout.write(
				'\r\x1b[K' + `${lastCaption.trim()} – ${e.detail.progress}%`
			);
			if (progress100) {
				process.stdout.write('\n');
			}
		});
		return compileBlueprint(blueprint as Blueprint, {
			progress: tracker,
		});
	}

	const command = args._[0] as string;
	if (!['run-blueprint', 'server', 'build-snapshot'].includes(command)) {
		yargsObject.showHelp();
		process.exit(1);
	}

	const compiledBlueprint = compileInputBlueprint();

	let requestHandler: PHPRequestHandler<NodePHP>;
	let wordPressReady = false;

	logger.log('Starting a PHP server...');

	startServer({
		port: args['port'] as number,
		onBind: async (port: number) => {
			const absoluteUrl = `http://127.0.0.1:${port}`;
			requestHandler = new PHPRequestHandler<NodePHP>({
				phpFactory: async ({ isPrimary }) =>
					createPhp(
						requestHandler,
						compiledBlueprint.versions.php,
						isPrimary
					),
				documentRoot: '/wordpress',
				absoluteUrl,
			});

			const php = await requestHandler.getPrimaryPhp();
			await prepareSite(php, compiledBlueprint.versions.wp, absoluteUrl);

			wordPressReady = true;

			if (compiledBlueprint) {
				const { php, reap } =
					await requestHandler.processManager.acquirePHPInstance();
				try {
					logger.log(`Running the Blueprint...`);
					await runBlueprintSteps(compiledBlueprint, php);
					logger.log(`Finished running the blueprint`);
				} finally {
					reap();
				}
			}

			if (command === 'build-snapshot') {
				await zipSite(args.outfile as string);
				logger.log(`WordPress exported to ${args.outfile}`);
				process.exit(0);
			} else if (command === 'run-blueprint') {
				logger.log(`Blueprint executed`);
				process.exit(0);
			} else {
				logger.log(`WordPress is running on ${absoluteUrl}`);
			}
		},
		async handleRequest(request: PHPRequest) {
			if (!wordPressReady) {
				return PHPResponse.forHttpCode(
					502,
					'WordPress is not ready yet'
				);
			}
			return await requestHandler.request(request);
		},
	});
}

run();
