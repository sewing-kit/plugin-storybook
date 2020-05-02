import {createPackage, Runtime} from '@sewing-kit/config';
import {buildFlexibleOutputs} from '@sewing-kit/plugin-package-flexible-outputs';
import {quiltWorkspace, quiltPackage} from '@quilted/sewing-kit-plugins';

export default createPackage((pkg) => {
  pkg.runtime(Runtime.Node);
  pkg.entry({root: './src/index'});
  pkg.use(
    quiltWorkspace({css: false}),
    quiltPackage(),
    buildFlexibleOutputs({
      binaries: false,
      commonjs: true,
      esmodules: false,
      esnext: false,
      node: false,
      typescript: true,
    }),
  );
});
