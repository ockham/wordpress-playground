import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { startServer } from './server';
import {
	PHPRequest,
	PHPRequestHandler,
	PHPResponse,
	SupportedPHPVersion,
	SupportedPHPVersions,
} from '@php-wasm/universal';
import { createPhp } from './setup-php';
import { setupWordPress } from './setup-wp';
import {
	Blueprint,
	compileBlueprint,
	defineSiteUrl,
	login,
	runBlueprintSteps,
} from '@wp-playground/blueprints';
import { RecommendedPHPVersion } from '@wp-playground/wordpress';
import { NodePHP } from '@php-wasm/node';
import { isValidWordPressSlug } from './is-valid-wordpress-slug';
import { EmscriptenDownloadMonitor, ProgressTracker } from '@php-wasm/progress';

/**
 * @TODO This looks similar to Query API args https://wordpress.github.io/wordpress-playground/query-api
 *       Perhaps the two could be handled by the same code?
 */
const args = await yargs(process.argv)
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
	.option('port', {
		describe: 'Port to listen on.',
		type: 'number',
		default: 9400,
	})
	.option('mount', {
		describe: 'Mount a directory to the PHP runtime.',
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
	.check((args) => {
		if (args.wp !== undefined && !isValidWordPressSlug(args.wp)) {
			throw new Error(
				'Unrecognized WordPress version. Please use "latest" or numeric versions such as "6.2", "6.0.1", "6.2-beta1", or "6.2-RC1"'
			);
		}
		if (args.blueprint !== undefined) {
			const blueprintPath = path.resolve(process.cwd(), args.blueprint);
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
	}).argv;

const tracker = new ProgressTracker();
let lastCaption = '';
tracker.addEventListener('progress', (e: any) => {
	lastCaption = e.detail.caption || lastCaption;
	process.stdout.write('\r\x1b[K' + `${lastCaption} – ${e.detail.progress}%`);
});
tracker.addEventListener('done', () => {
	process.stdout.write('\n');
});

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
const compiledBlueprint = compileBlueprint(blueprint as Blueprint, {
	progress: tracker,
});

export interface Mount {
	hostPath: string;
	vfsPath: string;
}
const mounts: Mount[] = (args.mount || []).map((mount) => {
	const [source, vfsPath] = mount.split(':');
	return {
		hostPath: path.resolve(process.cwd(), source),
		vfsPath,
	};
});

console.log('Starting PHP server...');

let requestHandler: PHPRequestHandler<NodePHP>;
let wordPressReady = false;

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
	process.stdout.write(`\rDownloading WordPress ${percentProgress}%...    `);
}) as any);

startServer({
	port: args.port,
	onBind: async (port: number) => {
		const absoluteUrl = `http://127.0.0.1:${port}`;
		requestHandler = new PHPRequestHandler({
			phpFactory: async ({ isPrimary }) =>
				createPhp(
					requestHandler,
					compiledBlueprint.versions.php,
					isPrimary
				),
			documentRoot: '/wordpress',
			absoluteUrl,
		});
		// Warm up and setup the PHP runtime
		const php = await requestHandler.getPrimaryPhp();

		// Put pre-configured WordPress in the /wordpress directory
		const mountingAtSlashWordPress = mounts.some(
			(mount) => mount.vfsPath === '/wordpress'
		);

		// No need to unzip WordPress if it's already mounted at /wordpress
		if (!mountingAtSlashWordPress) {
			console.log(
				`Setting up WordPress ${compiledBlueprint.versions.wp}`
			);
			await setupWordPress(php, compiledBlueprint.versions.wp, monitor);
			process.stdout.write('\n');
		}

		for (const mount of mounts) {
			php.mount(mount.hostPath, mount.vfsPath);
		}

		await defineSiteUrl(php, {
			siteUrl: absoluteUrl,
		});

		if (compiledBlueprint) {
			console.log(`Running a blueprint`);
			await runBlueprintSteps(compiledBlueprint, php);
			console.log(`Finished running the blueprint`);
		} else {
			if (args.login) {
				await login(php, {});
			}
		}
		wordPressReady = true;
		console.log(`WordPress is running on ${absoluteUrl}`);
	},
	async handleRequest(request: PHPRequest) {
		if (!wordPressReady) {
			return PHPResponse.forHttpCode(502, 'WordPress is not ready yet');
		}
		return await requestHandler.request(request);
	},
});