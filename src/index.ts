import {createProjectDevPlugin, WaterfallHook} from '@sewing-kit/plugins';

declare module '@sewing-kit/hooks' {
  interface DevProjectConfigurationCustomHooks {
    readonly storybookPort: WaterfallHook<number>;
  }
}

export function storybook() {
  return createProjectDevPlugin('Storybook', ({project, hooks}) => {
    hooks.configureHooks.hook(
      (hooks: import('@sewing-kit/hooks').DevProjectConfigurationHooks) => ({
        ...hooks,
        storybookPort: new WaterfallHook(),
      }),
    );
  });
}
