/**
 * What the fixtures saw, read by the scenarios. Plain module state: recording
 * must not re-render the fixtures it is observing.
 */
export const probes = {
  /** React events that reached the lab form, as `type:tag[type]` of their target. */
  formEvents: [] as string[],
  outsideClicks: 0,
  tabInputBlurs: 0,
};

export function resetProbes() {
  probes.formEvents = [];
  probes.outsideClicks = 0;
  probes.tabInputBlurs = 0;
}

export function recordFormEvent(event: { type: string; target: EventTarget }) {
  const target = event.target;
  const tag =
    target instanceof HTMLInputElement
      ? `input[${target.type}]`
      : target instanceof Element
        ? target.tagName.toLowerCase()
        : 'unknown';
  probes.formEvents.push(`${event.type}:${tag}`);
}
