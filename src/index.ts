// Storybook is very badly designed for tools to sit on top of it. To make this
// work, I’ve had to replicate the logic they use internally in their CLI command
// to run the development server (Storybook is basically just a fancy Webpack wrapper).
// There is no node API for using it, and the options for customizing Webpack don’t
// work here because Sewing Kit plugins hold the "shared" config we need access to.
//
// Most of the logic for setting up the Webpack dev servers is here:
// https://github.com/storybookjs/storybook/blob/next/lib/core/src/server/dev-server.js
//
// Most of their additional UI stuff around that server is here:
// https://github.com/storybookjs/storybook/blob/next/lib/core/src/server/build-dev.js
//
// Most of their preview (story code) Webpack config is in these files:
// https://github.com/storybookjs/storybook/blob/next/lib/core/src/server/preview/iframe-webpack.config.js
// https://github.com/storybookjs/storybook/blob/next/lib/core/src/server/preview/base-webpack.config.js
//
// I've only implemented dev, there is a build command but meh.
//
// React preset adds a few more configurations, not sure what to do with it:
// https://github.com/storybookjs/storybook/blob/next/app/react/src/server/options.ts

import * as fs from 'fs';
import * as path from 'path';

import {
  LogLevel,
  WaterfallHook,
  DiagnosticError,
  MissingPluginError,
  createProjectDevPlugin,
} from '@sewing-kit/plugins';
import {} from '@sewing-kit/plugin-webpack';

declare module '@sewing-kit/hooks' {
  interface DevProjectConfigurationCustomHooks {
    readonly storybookPort: WaterfallHook<number | undefined>;
    readonly storybookOutput: WaterfallHook<string>;
    readonly storybookEntries: WaterfallHook<string[]>;
    readonly storybookWebpackPlugins: WaterfallHook<import('webpack').Plugin[]>;
    readonly storybookWebpackConfig: WaterfallHook<
      import('webpack').Configuration
    >;
    readonly storybookManagerWebpackConfig: WaterfallHook<
      import('webpack').Configuration
    >;
  }
}

export interface Options {
  port?: number;
  config?: string;
}

const storybookCorePath = path.dirname(
  require.resolve('@storybook/core/package.json'),
);

const dllPath = path.join(storybookCorePath, 'dll');

export function storybook({port: defaultPort, config}: Options = {}) {
  return createProjectDevPlugin(
    'Storybook',
    ({project, hooks, api, workspace}) => {
      const configFile = config
        ? project.fs.resolvePath(config)
        : project.fs.resolvePath('.storybook/config');

      hooks.configureHooks.hook((hooks: any) => ({
        ...hooks,
        storybookPort: new WaterfallHook<number>(),
        storybookOutput: new WaterfallHook(),
        storybookEntries: new WaterfallHook(),
        storybookWebpackPlugins: new WaterfallHook(),
        storybookWebpackConfig: new WaterfallHook(),
        storybookManagerWebpackConfig: new WaterfallHook(),
      }));

      (hooks as import('@sewing-kit/hooks').DevPackageHooks).steps.hook(
        (steps, {configuration}) => {
          if (configuration.webpackConfig == null) {
            throw new MissingPluginError('@sewing-kit/plugin-webpack');
          }

          const step = api.createStep(
            {label: 'run storybook', id: 'Storybook.Run'},
            async (step) => {
              let webpackDevMiddlewareInstance:
                | ReturnType<typeof webpackDevMiddleware>
                | undefined;

              const outputDir = path.join(storybookCorePath, 'dist/public');
              const [
                {default: getPort},
                {default: express, Router},
                {default: webpack, DefinePlugin, HotModuleReplacementPlugin},
                {default: HtmlWebpackPlugin},
                {default: TerserWebpackPlugin},
                {default: webpackDevMiddleware},
                {default: webpackHotMiddleware},
                {default: webpackMerge},
              ] = await Promise.all([
                import('get-port'),
                import('express'),
                import('webpack'),
                import('html-webpack-plugin'),
                import('terser-webpack-plugin'),
                import('webpack-dev-middleware'),
                import('webpack-hot-middleware'),
                import('webpack-merge'),
              ] as const);

              const [aliases, extensions, rules] = await Promise.all([
                configuration.webpackAliases!.run({}),
                configuration.webpackExtensions!.run([]),
                configuration.webpackRules!.run([]),
              ] as const);

              step.indefinite(async ({stdio}) => {
                const app = express();
                const router = Router();

                async function runManager() {
                  const loadManagerConfig = require('@storybook/core/dist/server/manager/manager-config')
                    .default;
                  const managerWebpackConfig: import('webpack').Configuration = await configuration.storybookManagerWebpackConfig!.run(
                    webpackMerge(
                      await loadManagerConfig({
                        configType: 'DEVELOPMENT',
                        outputDir,
                        configDir: path.dirname(configFile),
                        cache: {},
                        corePresets: [
                          path.join(
                            storybookCorePath,
                            'dist/server/manager/manager-preset.js',
                          ),
                        ],
                      }),
                      {
                        resolve: {
                          extensions: extensions as any,
                          alias: aliases,
                        },
                        module: {
                          rules: rules as any,
                        },
                      },
                    ),
                  );

                  await new Promise((resolve) => {
                    webpack(managerWebpackConfig).watch(
                      {
                        aggregateTimeout: 1,
                        ignored: /node_modules/,
                      },
                      (error, stats) => {
                        if (error || stats.hasErrors()) {
                          if (webpackDevMiddlewareInstance) {
                            try {
                              webpackDevMiddlewareInstance.close();
                              step.log(
                                'Closed Storybook preview build process',
                                {
                                  level: LogLevel.Errors,
                                },
                              );
                            } catch {
                              step.log(
                                'Unable to close Storybook preview build process',
                                {level: LogLevel.Errors},
                              );
                            }
                          }

                          throw new DiagnosticError({
                            title: 'Storybook manager compilation failed',
                            content: `The compilation failed with the following output:\n\n${stats.toString(
                              'errors-warnings',
                            )}`,
                            suggestion:
                              'Try reinstalling your Storybook dependencies, as this generally indicates that Storybook’s web app code has been changed in your local node_modules.',
                          });
                        } else {
                          resolve(stats);
                        }
                      },
                    );
                  });
                }

                async function runPreview() {
                  const [entries, plugins, outputDirectory] = await Promise.all(
                    [
                      configuration.storybookEntries!.run([
                        path.join(
                          storybookCorePath,
                          'dist/server/common/polyfills.js',
                        ),
                        path.join(
                          storybookCorePath,
                          'dist/server/preview/globals.js',
                        ),
                        configFile,
                        `${require.resolve(
                          'webpack-hot-middleware/client.js',
                        )}?reload=true&quiet=true`,
                      ]),
                      configuration.storybookWebpackPlugins!.run([
                        new HtmlWebpackPlugin({
                          filename: 'iframe.html',
                          // Actual storybook is 'none', but seems to longer
                          // be accepted
                          // @see https://github.com/storybookjs/storybook/blob/f95829a2c07ae601e32874ef4f4a25bb8c485836/lib/core/src/server/manager/manager-webpack.config.js#L71
                          chunksSortMode: 'auto',
                          alwaysWriteToDisk: true,
                          inject: false,
                          templateParameters: (
                            compilation,
                            files,
                            options,
                          ) => ({
                            compilation,
                            files,
                            options,
                            version: require('@storybook/core/package.json')
                              .version,
                            globals: {},
                            headHtmlSnippet: getPreviewHeadHtml(process.env),
                            dlls: [],
                            bodyHtmlSnippet: getPreviewBodyHtml(process.env),
                          }),
                          template: path.join(
                            storybookCorePath,
                            'dist/server/templates/index.ejs',
                          ),
                        }),
                        new DefinePlugin({
                          NODE_ENV: JSON.stringify(process.env.NODE_ENV),
                          'process.env': {
                            NODE_ENV: '"development"',
                            NODE_PATH: '""',
                            PUBLIC_URL: '"."',
                          },
                        }),
                        new HotModuleReplacementPlugin(),
                      ]),
                      configuration.storybookOutput!.run(
                        workspace.fs.buildPath('storybook'),
                      ),
                    ] as const,
                  );

                  const previewWebpackConfig = await configuration.webpackConfig!.run(
                    {
                      mode: 'development',
                      entry: entries,
                      output: {
                        publicPath: '',
                        filename: '[name].[hash].bundle.js',
                        path: outputDirectory,
                      },
                      devtool: '#cheap-module-source-map',
                      plugins: plugins as any,
                      module: {rules: rules as any},
                      resolve: {
                        extensions: extensions as any,
                        alias: aliases,
                      },
                      optimization: {
                        splitChunks: {
                          chunks: 'all',
                        },
                        runtimeChunk: true,
                        minimizer: [
                          new TerserWebpackPlugin({
                            cache: true,
                            parallel: true,
                            sourceMap: true,
                            terserOptions: {
                              mangle: false,
                              // eslint-disable-next-line @typescript-eslint/camelcase
                              keep_fnames: true,
                            },
                          }),
                        ],
                      },
                    },
                  );

                  const previewCompiler = webpack(
                    await configuration.storybookWebpackConfig!.run(
                      previewWebpackConfig,
                    ),
                  );
                  webpackDevMiddlewareInstance = webpackDevMiddleware(
                    previewCompiler,
                    {
                      publicPath: previewWebpackConfig.output!.publicPath!,
                      watchOptions: {
                        aggregateTimeout: 1,
                        ignored: /node_modules/,
                      },
                      // this actually causes 0 (regular) output from wdm & webpack
                      logLevel: 'warn',
                    },
                  );

                  router.use(webpackDevMiddlewareInstance);
                  router.use(webpackHotMiddleware(previewCompiler));

                  await new Promise((resolve, reject) => {
                    webpackDevMiddlewareInstance!.waitUntilValid((stats) => {
                      if (!stats) {
                        reject(
                          new DiagnosticError({
                            title: 'Unable to build preview',
                          }),
                        );
                      } else if (stats.hasErrors()) {
                        reject(
                          new DiagnosticError({
                            title: 'Unable to build preview',
                            content: `The preview failed to build with the following output:\n\n${stats.toString(
                              'errors-warnings',
                            )}`,
                          }),
                        );
                      } else {
                        resolve(stats);
                      }
                    });
                  });
                }

                await Promise.all([runManager(), runPreview()]);

                router.get('/', (_, response) => {
                  response.set('Content-Type', 'text/html');
                  response.sendFile(path.join(`${outputDir}/index.html`));
                });

                router.get(/\/sb_dll\/(.+\.js)$/, (request, response) => {
                  response.set('Content-Type', 'text/javascript');
                  response.sendFile(
                    path.join(`${dllPath}/${request.params[0]}`),
                  );
                });

                router.get(/\/sb_dll\/(.+\.LICENCE)$/, (request, response) => {
                  response.set('Content-Type', 'text/html');
                  response.sendFile(
                    path.join(`${dllPath}/${request.params[0]}`),
                  );
                });

                router.get(/(.+\.js)$/, (request, response) => {
                  response.set('Content-Type', 'text/javascript');
                  response.sendFile(
                    path.join(`${outputDir}/${request.params[0]}`),
                  );
                });

                app.use(router);

                const port =
                  (await configuration.storybookPort!.run(defaultPort)) ??
                  (await getPort());
                app.listen(port, () => {
                  stdio.stdout.write(
                    `running storybook on localhost:${port}\n`,
                  );
                });
              });
            },
          );

          return [...steps, step];
        },
      );
    },
  );
}

const interpolate = (string: string, data = {}) =>
  Object.entries(data).reduce(
    (acc, [k, v]) => acc.replace(new RegExp(`%${k}%`, 'g'), v as any),
    string,
  );

function getPreviewBodyHtml(interpolations: object) {
  const template = fs.readFileSync(
    path.join(
      storybookCorePath,
      'dist/server/templates/base-preview-body.html',
    ),
    'utf8',
  );

  return interpolate(template, interpolations);
}

function getPreviewHeadHtml(interpolations: object) {
  const template = fs.readFileSync(
    path.join(
      storybookCorePath,
      'dist/server/templates/base-preview-head.html',
    ),
    'utf8',
  );

  return interpolate(template, interpolations);
}
