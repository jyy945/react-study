
/// 各优先级
var ImmediatePriority = 1; // 立即执行，优先级最高
var UserBlockingPriority = 2; // 用户堵塞
var NormalPriority = 3; // 正常
var IdlePriority = 4; // 闲置执行，优先级最低

// 各优先级对应的过期时间
var IMMEDIATE_PRIORITY_TIMEOUT = -1;
var USER_BLOCKING_PRIORITY = 250;
var NORMAL_PRIORITY_TIMEOUT = 5000;
var maxSigned31BitInt = 1073741823;
var IDLE_PRIORITY = maxSigned31BitInt;

// callback链表的第一个callback节点，callback链表是一个双向循环链表
var firstCallbackNode = null;

var currentPriorityLevel = NormalPriority;
var currentEventStartTime = -1;
var currentExpirationTime = -1;

// 是否有callback开始执行了
var isExecutingCallback = false;

// 是否已经开始调度了，在ensureHostCallbackIsScheduled设置为true
// 和isExecutingCallback的不同是，isExecutingCallback是包含在isHostCallbackScheduled中的
// isExecutingCallback只代表callback是否开始执行，而在一个调度中可能执行多个callback
// isHostCallbackScheduled代表开始对callback list进行迭代执行，只有当callback list清空时才会设置为false
var isHostCallbackScheduled = false;

function timeRemaining() {
  // Fallback to Date.now()
  if (
    firstCallbackNode !== null &&
    firstCallbackNode.expirationTime < currentExpirationTime
  ) {
    return 0;
  }
  var remaining = getFrameDeadline() - Date.now();
  return remaining > 0 ? remaining : 0;
}

// rICB中传递给执行函数的参数
var deadlineObject = {
  timeRemaining,  // 当前剩余的可执行时间
  didTimeout: false  // 是否已经过期
};

// 执行callback
// 1.查看是否已经有callback正在执行，若有则退出，不打断正在执行的callback
// 2.查看是否已经开始调度，若已经开始回调，TODO ?则将数据恢复初始状态。否则设置为开始调度
// 3.模拟requestIdleCallback，执行callback
function ensureHostCallbackIsScheduled() {
  // 若已经有回调正在执行，则退出，不能打断已经执行的回调
  if (isExecutingCallback) {
    return;
  }
  // 执行优先级最高的回调，若已经有正在执行的回调，则取消执行
  var expirationTime = firstCallbackNode.expirationTime;
  // TODO ?若已经有callback开始调度并执行，则取消执行该callback
  // 否则设置为true，开始调度新的callback
  if (!isHostCallbackScheduled) {
    isHostCallbackScheduled = true;
  } else {
    cancelHostCallback();
  }
  //执行callback
  requestHostCallback(flushWork, expirationTime);
}

// 执行掉第一个callback
function flushFirstCallback() {
  var flushedNode = firstCallbackNode;

  // 在调用callback之前，将callbackNode从callbackNode list中移除
  // 这样，即使回调抛出，列表也处于一致状态
  var next = firstCallbackNode.next;
  if (firstCallbackNode === next) { // callbackNode list中只有一个callbacNode，则设置list为空
    firstCallbackNode = null;
    next = null;
  } else {
    var lastCallbackNode = firstCallbackNode.previous;
    firstCallbackNode = lastCallbackNode.next = next;
    next.previous = lastCallbackNode;
  }

  flushedNode.next = flushedNode.previous = null; // 将当前的callbackNode和与之相邻的callbackNode切断关系

  var callback = flushedNode.callback;
  var expirationTime = flushedNode.expirationTime;
  var priorityLevel = flushedNode.priorityLevel;
  // 设置currentPriorityLevel和currentExpirationTime为最新的当前的callbackNodede信息
  var previousPriorityLevel = currentPriorityLevel;
  var previousExpirationTime = currentExpirationTime;
  currentPriorityLevel = priorityLevel;
  currentExpirationTime = expirationTime;

  var continuationCallback;
  try {
    continuationCallback = callback(deadlineObject);  // 执行callback
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentExpirationTime = previousExpirationTime;
  }

  // A callback may return a continuation. The continuation should be scheduled
  // with the same priority and expiration as the just-finished callback.
  // 若回调返回的值还是一个function，
  if (typeof continuationCallback === "function") {
    // 创建一个新的callbackNode
    var continuationNode: CallbackNode = {
      callback: continuationCallback,
      priorityLevel,
      expirationTime,
      next: null,
      previous: null
    };

    // 根据优先级将该callbackNode插入到callbackNode list 中
    if (firstCallbackNode === null) {
      firstCallbackNode = continuationNode.next = continuationNode.previous = continuationNode;
    } else {
      var nextAfterContinuation = null;
      var node = firstCallbackNode;
      do {
        if (node.expirationTime >= expirationTime) {
          nextAfterContinuation = node;
          break;
        }
        node = node.next;
      } while (node !== firstCallbackNode);

      if (nextAfterContinuation === null) {
        // No equal or lower priority callback was found, which means the new
        // callback is the lowest priority callback in the list.
        nextAfterContinuation = firstCallbackNode;
      } else if (nextAfterContinuation === firstCallbackNode) {
        // The new callback is the highest priority callback in the list.
        firstCallbackNode = continuationNode;
        ensureHostCallbackIsScheduled();
      }

      var previous = nextAfterContinuation.previous;
      previous.next = nextAfterContinuation.previous = continuationNode;
      continuationNode.next = nextAfterContinuation;
      continuationNode.previous = previous;
    }
  }
}

function flushImmediateWork() {
  if (
    // Confirm we've exited the outer most event handler
    currentEventStartTime === -1 &&
    firstCallbackNode !== null &&
    firstCallbackNode.priorityLevel === ImmediatePriority
  ) {
    isExecutingCallback = true;
    deadlineObject.didTimeout = true;
    try {
      do {
        flushFirstCallback();
      } while (
        // Keep flushing until there are no more immediate callbacks
      firstCallbackNode !== null &&
      firstCallbackNode.priorityLevel === ImmediatePriority
        );
    } finally {
      isExecutingCallback = false;
      if (firstCallbackNode !== null) {
        // There's still work remaining. Request another callback.
        ensureHostCallbackIsScheduled();
      } else {
        isHostCallbackScheduled = false;
      }
    }
  }
}

function flushWork(didTimeout) {
  isExecutingCallback = true; // 先设置isExecutingCallback为true，代表正在调用callback
  deadlineObject.didTimeout = didTimeout;
  try {
    if (didTimeout) { // 任务已经过期
      // 从firstCallbackNode向后一直执行，直到遇到第一个没过期的任务
      while (firstCallbackNode !== null) {
        // Read the current time. Flush all the callbacks that expire at or
        // earlier than that time. Then read the current time again and repeat.
        // This optimizes for as few performance.now calls as possible.
        var currentTime = getCurrentTime();
        // 若链表第一个的callbackNode已经过期
        if (firstCallbackNode.expirationTime <= currentTime) {
          do {
            flushFirstCallback();
          } while (
            firstCallbackNode !== null &&
            firstCallbackNode.expirationTime <= currentTime
            );
          continue;
        }
        break;
      }
    } else {
      // Keep flushing callbacks until we run out of time in the frame.
      if (firstCallbackNode !== null) {
        do {
          flushFirstCallback();
        } while (
          firstCallbackNode !== null &&
          getFrameDeadline() - getCurrentTime() > 0
          );
      }
    }
  } finally {
    isExecutingCallback = false;
    if (firstCallbackNode !== null) {
      // There's still work remaining. Request another callback.
      ensureHostCallbackIsScheduled();
    } else {
      isHostCallbackScheduled = false;
    }
    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_runWithPriority(priorityLevel, eventHandler) {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  var previousEventStartTime = currentEventStartTime;
  currentPriorityLevel = priorityLevel;
  currentEventStartTime = getCurrentTime();

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentEventStartTime = previousEventStartTime;

    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_wrapCallback(callback) {
  var parentPriorityLevel = currentPriorityLevel;
  return function () {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    var previousEventStartTime = currentEventStartTime;
    currentPriorityLevel = parentPriorityLevel;
    currentEventStartTime = getCurrentTime();

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
      currentEventStartTime = previousEventStartTime;
      flushImmediateWork();
    }
  };
}

// 对callback进行调度
// 1.根据callback的不同优先级计算过期时间
// 2.创建callbackNode
// 3.若callbackNode list中没有node，则直接执行
// 4.若callbackNode list中有node，则根据优先级找到newNode的插入点
function unstable_scheduleCallback(callback, deprecated_options) {
  var startTime =
    currentEventStartTime !== -1 ? currentEventStartTime : getCurrentTime();

  var expirationTime;
  if (
    typeof deprecated_options === "object" &&
    deprecated_options !== null &&
    typeof deprecated_options.timeout === "number"
  ) {
    // FIXME: Remove this branch once we lift expiration times out of React.
    expirationTime = startTime + deprecated_options.timeout;
  } else {
    // 根据不同的优先级计算过期时间
    switch (currentPriorityLevel) {
      case ImmediatePriority:
        expirationTime = startTime + IMMEDIATE_PRIORITY_TIMEOUT;
        break;
      case UserBlockingPriority:
        expirationTime = startTime + USER_BLOCKING_PRIORITY;
        break;
      case IdlePriority:
        expirationTime = startTime + IDLE_PRIORITY;
        break;
      case NormalPriority:
      default:
        expirationTime = startTime + NORMAL_PRIORITY_TIMEOUT;
    }
  }

  // 初始化node对象
  var newNode = {
    callback,
    priorityLevel: currentPriorityLevel, // 默认是正常的优先级：3
    expirationTime,
    next: null,
    previous: null
  };

  if (firstCallbackNode === null) { // callbackNode链表为空，将当前的callbackNode放入到链表中，并立即执行
    firstCallbackNode = newNode.next = newNode.previous = newNode;
    ensureHostCallbackIsScheduled();
  } else {
    var next = null;
    var node = firstCallbackNode;
    // 找到node list中第一个优先级低于newNode的node
    do {
      if (node.expirationTime > expirationTime) {
        // The new callback expires before this one.
        next = node;
        break;
      }
      node = node.next;
    } while (node !== firstCallbackNode);

    if (next === null) {
      // 所有callbackNode的优先级都高于newNode
      // 则将newNode放入链表最后位置
      next = firstCallbackNode;
    } else if (next === firstCallbackNode) {
      // 若第一个的callbackNode的优先级低于newNode，说明newNode的优先级最高
      // 则将newNode设置为链表第一个并立即执行
      firstCallbackNode = newNode;
      ensureHostCallbackIsScheduled();
    }

    // 将newNode插入到链表中
    var previous = next.previous;
    previous.next = next.previous = newNode;
    newNode.next = next;
    newNode.previous = previous;
  }

  return newNode;
}

function unstable_cancelCallback(callbackNode) {
  var next = callbackNode.next;
  if (next === null) {
    // Already cancelled.
    return;
  }

  if (next === callbackNode) {
    // This is the only scheduled callback. Clear the list.
    firstCallbackNode = null;
  } else {
    // Remove the callback from its position in the list.
    if (callbackNode === firstCallbackNode) {
      firstCallbackNode = next;
    }
    var previous = callbackNode.previous;
    previous.next = next;
    next.previous = previous;
  }

  callbackNode.next = callbackNode.previous = null;
}

function unstable_getCurrentPriorityLevel() {
  return currentPriorityLevel;
}

// 下面的代码为requestIdleCallback的polyfill。
// 它的工作原理是调度一个requestAnimationFrame，存储帧开始的时间，然后调度一个postMessage，该消息在绘制之后被调度。
// 在postMessage处理程序中尽可能多地执行工作，直到时间+帧速率。
// 通过将空闲调用分离为一个单独的事件标记，我们确保布局、绘制和其他浏览器工作都按可用时间计算。
// 帧速率是动态调整的。
// 本地化时间对象和系统方法
var localDate = Date;
var localSetTimeout = typeof setTimeout === "function" ? setTimeout : undefined;
var localClearTimeout =
  typeof clearTimeout === "function" ? clearTimeout : undefined;
var localRequestAnimationFrame =
  typeof requestAnimationFrame === "function"
  ? requestAnimationFrame
  : undefined;
var localCancelAnimationFrame =
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : undefined;

// 获取当前时
var getCurrentTime = function () {
  return localDate.now();
};

// 当网页切换时，react项目所在的选项卡此时会在后台
// 但是因为requestAnimationFrame在后台不运行，所以使用setTimeout作为备选，同时也将其执行时间改为100ms，从而减少了后台的性能消耗
var ANIMATION_FRAME_TIMEOUT = 100; // 后台执行setTimeout时的超时时间
var rAFID;  // requestAnimationFrame执行后返回的id，用于取消执行
var rAFTimeoutID; // setTimeout执行后返回的id， 用于取消执行
function requestAnimationFrameWithTimeout(callback) {
  rAFID = localRequestAnimationFrame(function (timestamp) {
    localClearTimeout(rAFTimeoutID);
    callback(timestamp);
  });
  rAFTimeoutID = localSetTimeout(function () {
    localCancelAnimationFrame(rAFID);
    callback(getCurrentTime());
  }, ANIMATION_FRAME_TIMEOUT);
}

// 已调度的callback
var scheduledHostCallback = null;

// 是否已经发送调用idleTick的消息，在animationTick中设置为true
var isMessageEventScheduled = false;
var timeoutTime = -1;

// 是否已经开始调用requestAnimationFrame
var isAnimationFrameScheduled = false;

// 是否正在执行callback
var isFlushingHostCallback = false;

// 记录当前帧的到期时间，他等于currentTime + activeFrameTime，也就是requestAnimationFrame回调传入的时间，加上一帧的时间。
var frameDeadline = 0;
// We start out assuming that we run at 30fps but then the heuristic tracking
// will adjust this value to a faster fps if we get more frequent animation
// frames.
// 上一帧的时间
var previousFrameTime = 33;

// 给一帧渲染用的时间，默认是 33，也就是 1 秒 30 帧
var activeFrameTime = 33;

var getFrameDeadline = function () {
  return frameDeadline;
};

// We use the postMessage trick to defer idle work until after the repaint.
var messageKey =
  "__reactIdleCallback$" +
  Math.random()
      .toString(36)
      .slice(2);

var idleTick = function (event) {
  // 判断这个postMesssage是不是自己的，如果不是自己的， 就直接退出
  if (event.source !== window || event.data !== messageKey) {
    return;
  }

  isMessageEventScheduled = false;

  var prevScheduledCallback = scheduledHostCallback;
  var prevTimeoutTime = timeoutTime;
  // callback执行完毕，将当前执行的callback和对应的过期时间重置
  scheduledHostCallback = null;
  timeoutTime = -1;

  var currentTime = getCurrentTime();

  var didTimeout = false;
  if (frameDeadline - currentTime <= 0) { // callback的执行时间已经超出了当前帧的结束时间
    if (prevTimeoutTime !== -1 && prevTimeoutTime <= currentTime) {// callback的过期时间已经到了
      didTimeout = true;
    } else {// callback的过期时间还没有到， 则重新对这个callback进行一次调度
      if (!isAnimationFrameScheduled) { // 若没有调用raf，则启动下一个raf
        isAnimationFrameScheduled = true;
        requestAnimationFrameWithTimeout(animationTick);
      }
      // Exit without invoking the callback.
      scheduledHostCallback = prevScheduledCallback;
      timeoutTime = prevTimeoutTime;
      return;
    }
  }

  if (prevScheduledCallback !== null) {
    isFlushingHostCallback = true;
    try {
      prevScheduledCallback(didTimeout);
    } finally {
      isFlushingHostCallback = false;
    }
  }
};
// Assumes that we have addEventListener in this environment. Might need
// something better for old IE.
window.addEventListener("message", idleTick, false);

var animationTick = function (rafTime) {
  if (scheduledHostCallback !== null) { // 若有正在调度的callback，则执行
    // 急切地在帧的开始处安排下一个动画回调。
    // 如果调度程序队列在帧末尾不为空，它将在该回调内继续刷新。
    // 如果队列*为*空，则它将立即退出。
    // 在帧的开始处发布回调可确保在尽可能早的帧内触发回调。
    // 如果我们等到帧结束后才发布回调，那么浏览器就有可能跳过一个帧而在该帧之后才触发回调
    requestAnimationFrameWithTimeout(animationTick);
  } else {
    // 若没有已经调度的callback，则退出
    isAnimationFrameScheduled = false;
    return;
  }

  // rafTime - frameDeadline为计算当前时间和上一帧设置的截止时间
  // 若大于0，表示任务在截止时间之前完成了
  // 若小于0，表示任务延后了
  // 加上activeFrameTime后，可以用于动态设置帧的时长
  var nextFrameTime = rafTime - frameDeadline + activeFrameTime;
  // 若当前的帧时长和上一帧的时长小于activeFrameTime
  // 说明帧时长很短，显示器的刷新频率很高，帧时长低于设置好的activeFrameTime，需要重新设置activeFrameTime
  if (
    nextFrameTime < activeFrameTime &&
    previousFrameTime < activeFrameTime
  ) {
    // 若显示器的刷新频率高于120hz，则react不对其进行支持。
    // 也就是react设置为每帧最短时间为8ms
    if (nextFrameTime < 8) {
      nextFrameTime = 8;
    }
    // If one frame goes long, then the next one can be short to catch up.
    // If two frames are short in a row, then that's an indication that we
    // actually have a higher frame rate than what we're currently optimizing.
    // We adjust our heuristic dynamically accordingly. For example, if we're
    // running on 120hz display or 90hz VR display.
    // Take the max of the two in case one of them was an anomaly due to
    // missed frame deadlines.

    // 因为最近两次的帧时长都低于activeFreameTime，说明平台的帧率很高，需要动态的缩小帧时长
    activeFrameTime =
      nextFrameTime < previousFrameTime ? previousFrameTime : nextFrameTime;
  } else {  // 若最近两次的帧时长并不比activeFrameTime小，说明设置的activeFrameTime 33ms
    previousFrameTime = nextFrameTime;
  }
  frameDeadline = rafTime + activeFrameTime; // 获取下一帧的截止时间
  if (!isMessageEventScheduled) {
    isMessageEventScheduled = true;
    window.postMessage(messageKey, "*");
  }
};

// 发起callback调度
var requestHostCallback = function (callback, absoluteTimeout) {
  scheduledHostCallback = callback;
  timeoutTime = absoluteTimeout;
  if (isFlushingHostCallback || absoluteTimeout < 0) {
    // Don't wait for the next frame. Continue working ASAP, in a new event.
    window.postMessage(messageKey, "*");
  } else if (!isAnimationFrameScheduled) {
    // 若requestAnimationFrame还没有被调用过，则需要进行调度
    // 若浏览器没有实现requestAnimationFrame，则可以使用setTimeout触发requestIdleCallback来替代他
    isAnimationFrameScheduled = true;
    // 启动raf执行callback
    requestAnimationFrameWithTimeout(animationTick);
  }
};

var cancelHostCallback = function () {
  scheduledHostCallback = null;
  isMessageEventScheduled = false;
  timeoutTime = -1;
};

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  unstable_runWithPriority,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  getCurrentTime as unstable_now
};
