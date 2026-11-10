// Client files are embedded as text (`with { type: "text" }`), also in the compiled binary.
declare module "*/index.html" {
  const text: string;
  export default text;
}
declare module "*/style.css" {
  const text: string;
  export default text;
}
declare module "*/app.js" {
  const text: string;
  export default text;
}
declare module "*/markdown.js" {
  const text: string;
  export default text;
}
// Binary assets are embedded as files (`with { type: "file" }`): the import is a path for Bun.file().
declare module "*.woff2" {
  const path: string;
  export default path;
}
