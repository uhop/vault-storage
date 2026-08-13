// Shared event utilities for components.

// handleEvent dispatch map: makeHandlers('click', 'keydown') →
// {click: 'onClick', keydown: 'onKeydown'}.
export const makeHandlers = (...types) =>
  Object.fromEntries(types.map(type => [type, 'on' + type[0].toUpperCase() + type.slice(1)]));
