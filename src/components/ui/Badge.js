// Status pill classes, replacing `.badge` and its `.paid` / `.refunded`
// modifiers. A function rather than a component, because the status arrives as
// a dynamic string and several call sites need the classes on an existing
// element.
const tones = {
  paid: 'bg-[#e8eee5] text-[#46663b]',
  refunded: 'bg-[#e7e7e7] text-[#555]',
};

const base =
  'inline-flex items-center justify-center justify-self-start rounded-[20px] ' +
  'px-3 py-[7px] text-[10px] tracking-[0.3px] capitalize';

export function badgeClasses(status) {
  return `${base} ${tones[status] ?? 'bg-[#eee8db] text-[#846734]'}`;
}
