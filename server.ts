/**
 * OpenCode server entrypoint. OpenCode resolves a plugin package at `./server`
 * (falling back to `.`); both point here so `Host.resolve` finds the module.
 */
export { default, plugin } from "./src/index";