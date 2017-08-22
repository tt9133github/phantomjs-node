/* eslint-env phantomjs */

import webpage from 'webpage';
import system from 'system';
import './function_bind_polyfill.js';

/**
 * Stores all all pages and single instance of phantom
 */
const objectSpace = {
  phantom,
};

const events = {};
const NOOP = 'NOOP';

/**
 * All commands that have a custom implementation
 */
const commands = {
  createPage: (command) => {
    const page = webpage.create();
    objectSpace[`page$${command.id}`] = page;

    page.onClosing = () => delete objectSpace[`page$${command.id}`];

    command.response = { pageId: command.id };
    completeCommand(command);
  },
  property: (command) => {
    if (command.params.length > 1) {
      if (typeof command.params[1] === 'function') {
        // If the second parameter is a function then we want to proxy and pass parameters too
        const callback = command.params[1];
        const args = command.params.slice(2);
        syncOutObjects(args);
        objectSpace[command.target][command.params[0]] = function () {
          const params = [].slice.call(arguments).concat(args);
          return callback.apply(objectSpace[command.target], params);
        };
      } else {
        // If the second parameter is not a function then just assign
        objectSpace[command.target][command.params[0]] = command.params[1];
      }
    } else {
      command.response = objectSpace[command.target][command.params[0]];
    }

    completeCommand(command);
  },
  setting: (command) => {
    if (command.params.length === 2) {
      objectSpace[command.target].settings[command.params[0]] = command.params[1];
    } else {
      command.response = objectSpace[command.target].settings[command.params[0]];
    }

    completeCommand(command);
  },

  windowProperty: (command) => {
    if (command.params.length === 2) {
      window[command.params[0]] = command.params[1];
    } else {
      command.response = window[command.params[0]];
    }
    completeCommand(command);
  },

  addEvent: (command) => {
    const type = getTargetType(command.target);

    if (isEventSupported(type, command.params[0].type)) {
      const listeners = getEventListeners(command.target, command.params[0].type);

      if (typeof command.params[0].event === 'function') {
        listeners.otherListeners.push(function () {
          const params = [].slice.call(arguments).concat(command.params[0].args);
          return command.params[0].event.apply(objectSpace[command.target], params);
        });
      }
    }

    completeCommand(command);
  },

  removeEvent(command) {
    const type = getTargetType(command.target);

    if (isEventSupported(type, command.params[0].type)) {
      events[command.target][command.params[0].type] = null;
      objectSpace[command.target][command.params[0].type] = null;
    }

    completeCommand(command);
  },

  noop: command => completeCommand(command),

  invokeAsyncMethod(command) {
    const target = objectSpace[command.target];
    target[command.params[0]](...command.params.slice(1).concat((result) => {
      command.response = result;
      completeCommand(command);
    }));
  },

  invokeMethod(command) {
    const target = objectSpace[command.target];
    const method = target[command.params[0]];
    command.response = method.apply(target, command.params.slice(1));
    completeCommand(command);
  },

  defineMethod(command) {
    const target = objectSpace[command.target];
    target[command.params[0]] = command.params[1];
    completeCommand(command);
  },
};

/**
 * Calls readLine() and blocks until a message is ready
 */
function read() {
  const line = system.stdin.readLine();
  if (line) {
    if (line === NOOP) {
      system.stdout.writeLine(`>${NOOP}`);
      setTimeout(read, 100);
      return;
    }
    const command = JSON.parse(line, (key, value) => {
      if (value
                && typeof value === 'string'
                && value.substr(0, 8) === 'function'
                && value.indexOf('[native code]') === -1) {
        const startBody = value.indexOf('{') + 1;
        const endBody = value.lastIndexOf('}');
        const startArgs = value.indexOf('(') + 1;
        const endArgs = value.indexOf(')');

        // eslint-disable-next-line no-new-func
        return new Function(value.substring(startArgs, endArgs), value.substring(startBody, endBody));
      }
      return value;
    });

    // Call here to look for transform key
    transform(command.params);

    try {
      executeCommand(command);
    } catch (e) {
      command.error = e.message;
      completeCommand(command);
    } finally {
      setTimeout(read, 0);
    }
  }
}

/**
 * Looks for transform key and uses objectSpace to call objects
 * @param object
 */
function transform(object) {
  for (const key in object) {
    if (object.hasOwnProperty(key)) {
      const child = object[key];
      if (child === null || child === undefined) {
        return;
      } else if (child.transform === true) {
        object[key] = objectSpace[child.parent][child.method](child.target);
      } else if (typeof child === 'object') {
        transform(child);
      }
    }
  }
}

/**
 * Sync all OutObjects present in the array
 *
 * @param objects
 */
function syncOutObjects(objects) {
  objects.forEach((param) => {
    if (param.target !== undefined) {
      objectSpace[param.target] = param;
    }
  });
}

/**
 * Executes a command.
 * @param command the command to execute
 */
function executeCommand(command) {
  if (commands[command.name]) {
    return commands[command.name](command);
  }
  throw new Error(`'${command.name}' isn't a command.`);
}

/**
 * Verifies if an event is supported for a type of target
 *
 * @param type
 * @param eventName
 * @returns {boolean}
 */
function isEventSupported(type, eventName) {
  return type === 'page' && eventName.indexOf('on') === 0;
}

/**
 * Gets an object containing all the listeners for an event of a target
 *
 * @param target the target id
 * @param eventName the event name
 */
function getEventListeners(target, eventName) {
  if (!events[target]) {
    events[target] = {};
  }

  if (!events[target][eventName]) {
    events[target][eventName] = {
      outsideListener: getOutsideListener(eventName, target),
      otherListeners: [],
    };

    objectSpace[target][eventName] = triggerEvent.bind(null, target, eventName);
  }

  return events[target][eventName];
}

/**
 * Determines a targets type using its id
 *
 * @param target
 * @returns {*}
 */
function getTargetType(target) {
  return target.toString().split('$')[0];
}

/**
 * Executes all the listeners for an event from a target
 *
 * @param target
 * @param eventName
 */
function triggerEvent(target, eventName) {
  const args = [].slice.call(arguments, 2);
  const listeners = events[target][eventName];
  listeners.outsideListener.apply(null, args);
  listeners.otherListeners.forEach((listener) => {
    listener.apply(objectSpace[target], args);
  });
}

/**
 * Returns a function that will notify to node that an event have been triggered
 *
 * @param eventName
 * @param targetId
 * @returns {Function}
 */
function getOutsideListener(eventName, targetId) {
  return function () {
    const args = [].slice.call(arguments, 0);
    system.stdout.writeLine(`<event>${JSON.stringify({ target: targetId, type: eventName, args })}`);
  };
}

/**
 * Completes a command by return a response to node and listening again for next command.
 * @param command
 */
function completeCommand(command) {
  system.stdout.writeLine(`>${JSON.stringify(command)}`);
}

read();
