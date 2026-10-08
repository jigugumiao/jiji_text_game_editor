// 后台备份只绑定进入编辑器的项目；在途任务始终使用捕获的项目 id。
(function () {
  'use strict';
  var INTERVAL_MS = 3 * 60 * 1000;
  function createController(options) {
    var schedule = options.setTimeout || setTimeout;
    var cancel = options.clearTimeout || clearTimeout;
    var now = options.now || Date.now;
    var session = null, timer = null, pending = null;
    async function run(reason) {
      var current = session;
      if (!current) return null;
      if (pending) {
        if (pending.session === current) return pending.promise;
        await pending.promise;
        if (session !== current) return null;
      }
      var task = { session: current };
      pending = task;
      task.promise = (async function () {
        try {
          options.flush(current.pid);
          var result = await options.backup(current.pid, reason || 'auto');
          if (session === current && options.onStatus) options.onStatus(null, result);
          return result;
        } catch (error) {
          if (session === current && options.onStatus) options.onStatus(error);
          return null;
        } finally { if (pending === task) pending = null; }
      })();
      return task.promise;
    }
    function arm(current) {
      current.due = now() + INTERVAL_MS;
      timer = schedule(function () { tick(current); }, INTERVAL_MS);
    }
    async function tick(current) {
      if (session !== current) return;
      timer = null;
      await run('auto');
      if (session === current) arm(current);
    }
    function stop() {
      session = null;
      if (timer != null) cancel(timer);
      timer = null;
      return pending ? pending.promise : Promise.resolve();
    }
    function start(pid) {
      stop();
      session = { pid: pid };
      arm(session);
      return run('open');
    }
    function checkDue() {
      if (session && now() >= session.due) {
        if (timer != null) cancel(timer);
        return tick(session);
      }
      return Promise.resolve();
    }
    return { start: start, stop: stop, backupNow: function () { return run('manual'); }, checkDue: checkDue };
  }
  var api = { INTERVAL_MS: INTERVAL_MS, createController: createController };
  if (typeof window !== 'undefined') window.TimeMachine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
