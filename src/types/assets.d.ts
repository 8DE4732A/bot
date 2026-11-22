/** Bun 资源导入（`with { type: "file" }`）得到的是可被 Bun.file 读取的路径。 */
declare module "*.wasm" {
  const path: string;
  export default path;
}
