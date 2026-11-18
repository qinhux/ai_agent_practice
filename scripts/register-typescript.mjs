// Async module hooks work on every Node version supported by this project.
import { register } from "node:module";
register("./typescript-loader.mjs", import.meta.url);
