// ink/build/devtools.js 仅在 process.env.DEV === "true" 且本包可解析时被动态加载。
// stub 提供与真实包相同的调用面 (initialize/connectToDevTools), 但不做任何事——
// 二进制产物中 React DevTools 连接功能本就不支持 (开发时用 bun run 源码 + 真包)。
export default {
  initialize() {},
  connectToDevTools() {},
};
