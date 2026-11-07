export function hasAbnormalGraphicsExit(events) {
 return events.some(event => /gpu|renderer/i.test(event.type || '') && (event.reason !== 'clean-exit' || event.exitCode !== 0));
}
