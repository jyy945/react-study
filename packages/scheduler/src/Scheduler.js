
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

// 距离一帧结束还有多长时间
function timeRemaining() {
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

// 开始调度callbackNode list中的第一个callbackNode
// 1.查看是否已经有flushwork正在执行，若有则退出，
// 2.查看callbackNode List 中是否还有callbackNode，若有则停止调度
// 3.模拟requestIdleCallback执行
function ensureHostCallbackIsScheduled() {
  // 若已经有flushWork正在执行，则退出，因为此时已经有idleTick从微任务队列中取出并执行，已经没有办法将其打断，所以只能等待其执行完毕。
  // 然后会自动对callbackNode List中的任务进行调度。
  if (isExecutingCallback) {
    return;
  }
  // 执行优先级最高的回调，若已经有正在执行的回调，则取消执行
  var expirationTime = firstCallbackNode.expirationTime;
  // 若isHostCallbackScheduled为false，表示callbackNode list已经全部被执行完,此时callbackNodeList为空。
  // 由于当前加入了一个newNode，所以callbackNodeList不再为空，可以开始对其进行遍历执行了
  if (!isHostCallbackScheduled) {
    isHostCallbackScheduled = true;
  } else {
    // 若isHostCallbackScheduled为true，表示callbackNode list还有callback被调度执行。
    // 由于加入了newNode，并且newNode的优先级高，所以需要取消之前的调度信息，重新开始执行
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
      // 也就是把callbackNode中所有已经过期的任务执行掉
      while (firstCallbackNode !== null) {
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
      // 若任务没有过期，当帧还有剩余的时间，则继续去执行掉callbackNode list中的callbackNode
      if (firstCallbackNode !== null) {
        do {
          flushFirstCallback();
        } while (
          firstCallbackNode !== null && // callbackNode List中还有未处理的callbackNode
          getFrameDeadline() - getCurrentTime() > 0 // 当前帧还有剩余时间
          );
      }
    }
  } finally {
    isExecutingCallback = false;  // callbackNode执行结束，设置为false
    if (firstCallbackNode !== null) {// callbackNode list中还有callbackNode，则去开启requestAnimationFrame
      ensureHostCallbackIsScheduled();
    } else {// callbackNode List中的callbackNode都已经执行完毕，链表为空
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

// 对任务进行调度
// 1.根据任务的不同优先级计算过期时间
// 2.创建callbackNode并根据优先级将其插入到callbackNode list中（优先级从高到低）
// 3.若当前任务对应的callbackNode为callbackNode list中的第一个，也就是其优先级是最高的话，
// 则执行ensureHostCallbackIsScheduled，开始对这个任务进行调度；若不是list中的第一个，则不需操作，因为会自动执行list中的callbackNode
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
  if (firstCallbackNode === null) { // callbackNode链表为空，将当前的callbackNode放入到链表中，并进行调度
    firstCallbackNode = newNode.next = newNode.previous = newNode;
    ensureHostCallbackIsScheduled();
  } else {
    var next = null;
    var node = firstCallbackNode;
    // 在list中找到第一个优先级低于newNode的callbackNode
    do {
      if (node.expirationTime > expirationTime) {
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
      // 则将newNode设置为链表第一个并立即对其进行调度
      firstCallbackNode = newNode;
      ensureHostCallbackIsScheduled();
    }
    // 将newNode插入到链表中
    // 虽然先执行了ensureHostCallbackIsScheduled，但是因为任务会放在微任务队列中，在调入执行栈后，任务才能执行并删除
    // 所以必然是先执行以下插入的操作，等到主程序已经执行完才会从微任务队列中执行任务，此时callbackNode已经完成插入操作
    var previous = next.previous;
    previous.next = next.previous = newNode;
    newNode.next = next;
    newNode.previous = previous;
  }
  return newNode;
}

// 取消callbackNode的调度，将其从callbackNode list 中移出
function unstable_cancelCallback(callbackNode) {
  var next = callbackNode.next;
  if (next === null) { // 若next为null，表示这个node已经取消调度了
    return;
  }

  if (next === callbackNode) { // callbackNode list只有一个
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
// 此处的callback为animationTick
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

// 已调度的flushWork
var scheduledHostCallback = null;

// 是否已经发送调用idleTick的消息，在animationTick中设置为true
var isMessageEventScheduled = false;
// 执行本次调度任务的超时时间
var timeoutTime = -1;

// 是否已经开始调用requestAnimationFrame
var isAnimationFrameScheduled = false;

// 是否正在执行flushWork
var isFlushingHostCallback = false;

// 记录当前帧的到期时间，他等于currentTime + activeFrameTime，也就是requestAnimationFrame回调传入的时间，加上一帧的时间。
var frameDeadline = 0;
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

// 每次requestAnimationFrame执行后，每帧都会触发idleTick
// 因为window.postMessage出发后的事件为微任务，会在本次主程序执行完毕后去执行微任务，也就相当于在主线程空闲时间执行微任务
// 此时就相当于requestIdleCallback的空闲时间执行的功能
var idleTick = function (event) {
  // 判断这个postMesssage是不是自己的，如果不是自己的， 就直接退出
  if (event.source !== window || event.data !== messageKey) {
    return;
  }

  // 设置为false，这样在animationTick中才能触发window.postMessage，相当于开启了浏览器将下一个idleTick放入微任务队列的开关
  isMessageEventScheduled = false;

  // 本次的callback：flushWork设置为上次，方便scheduledHostCallback记录新的flushWork
  var prevScheduledCallback = scheduledHostCallback;  // flushWork
  var prevTimeoutTime = timeoutTime;
  // callback执行完毕，将当前执行的callback和对应的过期时间重置
  scheduledHostCallback = null;
  timeoutTime = -1;

  var currentTime = getCurrentTime();

  var didTimeout = false;
  // 本次帧的截止时间超时了，
  // 表示浏览器更新dom或者是处理用户返回的时间已经超过了activeFrameTime,也就是已经把这一帧的时间用完了
  if (frameDeadline - currentTime <= 0) {
    if (prevTimeoutTime !== -1 && prevTimeoutTime <= currentTime) {// callback的过期时间已经到了
      didTimeout = true;
    } else { // 由于callback还没有执行，帧的截止时间就到了，同时这个callback的截止时间还没有到，则需要将这个callback安排到另外的一帧去执行
      // 由于此时可能callbackList中已经没有了callbackNode，但因为需要将未执行的callback放入执行栈，所以需要重新启动requestAnimationFrame
      if (!isAnimationFrameScheduled) { // 启动requestAnimationFrame
        isAnimationFrameScheduled = true;
        requestAnimationFrameWithTimeout(animationTick);
      }
      // 将当前的callback设置为调度状态并退出
      scheduledHostCallback = prevScheduledCallback;
      timeoutTime = prevTimeoutTime;
      return;
    }
  }

  // 若帧的截止时间还没有到，也就是当前帧已经有了空闲时间去执行任务，或者是截止时间到了而且任务已经超时，则需要立即执行任务。
  if (prevScheduledCallback !== null) {
    isFlushingHostCallback = true;
    try {
      prevScheduledCallback(didTimeout); // 执行任务，也就是执行flushWork
    } finally {
      isFlushingHostCallback = false;
    }
  }
};
// Assumes that we have addEventListener in this environment. Might need
// something better for old IE.
window.addEventListener("message", idleTick, false);

// requestAnimationFrame的参数，也是每一帧开始时执行的回调
// rafTime为当前时间
var  animationTick = function (rafTime) {
  if (scheduledHostCallback !== null) { // 若有正在调度的callback，则执行
    // 递归调用，这样每一帧才能去执行
    // 在帧的开始处发布回调可确保在尽可能早的帧内触发回调。
    // 如果我们等到帧结束后才发布回调，那么浏览器就有可能跳过一个帧而在该帧之后才触发回调
    requestAnimationFrameWithTimeout(animationTick);
  } else {
    // 若没有已经调度的callback，则关闭requestAnimationFrame
    isAnimationFrameScheduled = false;
    return;
  }

  //以下代码为动态设置帧时长
  // rafTime - frameDeadline为计算当前时间和上一帧设置的截止时间
  // 若大于0，表示任务在截止时间之前完成了
  // 若小于0，表示任务延后了
  // 加上activeFrameTime后，就是下一帧的时长
  var nextFrameTime = rafTime - frameDeadline + activeFrameTime;
  // 最近两次的帧时长均小于activeFrameTime
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
    // activeFrameTime选择为最近两次帧最长的时长
    activeFrameTime =
      nextFrameTime < previousFrameTime ? previousFrameTime : nextFrameTime;
  } else { // 最近两次的帧时长均不小于activeFrameTime，则频率稳定，将本次帧时长赋给previousFrameTime
    previousFrameTime = nextFrameTime;
  }
  frameDeadline = rafTime + activeFrameTime; // 获取下一帧的截止时间
  // 若还未发送调用idleTick，则使用postMessage发送信息
  if (!isMessageEventScheduled) {
    isMessageEventScheduled = true;
    window.postMessage(messageKey, "*");
  }
};

/**
 * 发起callback调度
 * @param callback 此处的callback为flushWork，需要被传入一个didTimeout的参数，用于标记是否已经过期
 * @param absoluteTimeout 绝对时间
 */
var requestHostCallback = function (callback, absoluteTimeout) {
  scheduledHostCallback = callback;
  timeoutTime = absoluteTimeout;
  if (isFlushingHostCallback || absoluteTimeout < 0) { // 若正在执行flushWork或者是当前的callbackNode已经过期，则立即callbackNode
    window.postMessage(messageKey, "*");
  } else if (!isAnimationFrameScheduled) {
    // 若requestAnimationFrame还没有被调用过，则需要进行调度
    isAnimationFrameScheduled = true;
    // 启动raf执行callback
    requestAnimationFrameWithTimeout(animationTick);
  }
};

// 取消之前的调度，将相关信息重置
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
