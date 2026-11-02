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
