import 'bare-node-runtime/global'
export * from './dist/index.js' with { imports: 'bare-node-runtime/imports' }
export { default } from './dist/index.js' with { imports: 'bare-node-runtime/imports' }
