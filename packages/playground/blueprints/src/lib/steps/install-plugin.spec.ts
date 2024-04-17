import { NodePHP } from '@php-wasm/node';
import { RecommendedPHPVersion } from '@wp-playground/wordpress';
import { installPlugin } from './install-plugin';
import { phpVar } from '@php-wasm/util';

async function zipFiles(
	php: NodePHP,
	fileName: string,
	files: Record<string, string>
) {
	const zipFileName = 'test.zip';
	const zipFilePath = `/${zipFileName}`;

	await php.run({
		code: `<?php $zip = new ZipArchive(); 
					 $zip->open("${zipFileName}", ZIPARCHIVE::CREATE); 
					 $files = ${phpVar(files)};
					 foreach($files as $path => $content) {
						$zip->addFromString($path, $content);
					 }
					 $zip->close();`,
	});

	const zip = await php.readFileAsBuffer(zipFilePath);
	php.unlink(zipFilePath);
	return new File([zip], fileName);
}

describe('Blueprint step installPlugin – without a root-level folder', () => {
	it('should install a plugin even when it is zipped directly without a root-level folder', async () => {
		const php = await NodePHP.load(RecommendedPHPVersion, {
			requestHandler: {
				documentRoot: '/wordpress',
			},
		});

		// Create plugins folder
		const rootPath = php.documentRoot;
		const pluginsPath = `${rootPath}/wp-content/plugins`;
		php.mkdir(pluginsPath);

		// Create test plugin
		const pluginName = 'test-plugin';

		await installPlugin(php, {
			pluginZipFile: await zipFiles(
				php,
				// Note the ZIP filename is different from plugin folder name
				`${pluginName}-0.0.1.zip`,
				{
					'index.php': `/**\n * Plugin Name: Test Plugin`,
				}
			),
			ifAlreadyInstalled: 'overwrite',
			options: {
				activate: false,
			},
		});

		expect(php.fileExists(`${pluginsPath}/${pluginName}-0.0.1`)).toBe(true);
	});
});

describe('Blueprint step installPlugin', () => {
	let php: NodePHP;
	// Create plugins folder
	let rootPath = '';
	let installedPluginPath = '';
	const pluginName = 'test-plugin';
	const zipFileName = `${pluginName}-0.0.1.zip`;
	beforeEach(async () => {
		php = await NodePHP.load(RecommendedPHPVersion, {
			requestHandler: {
				documentRoot: '/wordpress',
			},
		});
		rootPath = php.documentRoot;
		php.mkdir(`${rootPath}/wp-content/plugins`);
		installedPluginPath = `${rootPath}/wp-content/plugins/${pluginName}`;
	});

	afterEach(() => {
		php.exit();
	});

	it('should install a plugin', async () => {
		await installPlugin(php, {
			pluginZipFile: await zipFiles(php, zipFileName, {
				[`${pluginName}/index.php`]: `/**\n * Plugin Name: Test Plugin`,
			}),
			ifAlreadyInstalled: 'overwrite',
			options: {
				activate: false,
			},
		});
		expect(php.fileExists(installedPluginPath)).toBe(true);
	});

	describe('ifAlreadyInstalled option', () => {
		beforeEach(async () => {
			await installPlugin(php, {
				pluginZipFile: await zipFiles(php, zipFileName, {
					[`${pluginName}/index.php`]: `/**\n * Plugin Name: Test Plugin`,
				}),
				ifAlreadyInstalled: 'overwrite',
				options: {
					activate: false,
				},
			});
		});

		it('ifAlreadyInstalled=overwrite should overwrite the plugin if it already exists', async () => {
			// Install the plugin
			await installPlugin(php, {
				pluginZipFile: await zipFiles(php, zipFileName, {
					[`${pluginName}/index.php`]: `/**\n * Plugin Name: A different Plugin`,
				}),
				ifAlreadyInstalled: 'overwrite',
				options: {
					activate: false,
				},
			});
			expect(
				php.readFileAsText(`${installedPluginPath}/index.php`)
			).toContain('Plugin Name: A different Plugin');
		});

		it('ifAlreadyInstalled=skip should skip the plugin if it already exists', async () => {
			// Install the plugin
			await installPlugin(php, {
				pluginZipFile: await zipFiles(php, zipFileName, {
					[`${pluginName}/index.php`]: `/**\n * Plugin Name: A different Plugin`,
				}),
				ifAlreadyInstalled: 'skip',
				options: {
					activate: false,
				},
			});
			expect(
				php.readFileAsText(`${installedPluginPath}/index.php`)
			).toContain('Plugin Name: Test Plugin');
		});

		it('ifAlreadyInstalled=error should throw an error if the plugin already exists', async () => {
			// Install the plugin
			await expect(
				installPlugin(php, {
					pluginZipFile: await zipFiles(php, zipFileName, {
						[`${pluginName}/index.php`]: `/**\n * Plugin Name: A different Plugin`,
					}),
					ifAlreadyInstalled: 'error',
					options: {
						activate: false,
					},
				})
			).rejects.toThrowError();
		});
	});
});