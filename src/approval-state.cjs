function approvalState(approve) {
  let observer = () => {};
  return {
    observe(callback) { observer = typeof callback === 'function' ? callback : () => {}; },
    async confirm(request, name) {
      request.signal?.throwIfAborted(); observer({ name, state: 'awaiting_approval' });
      try {
        const allowed = await approve(request); request.signal?.throwIfAborted();
        observer({ name, state: allowed ? 'started' : 'approval_declined' }); return allowed;
      } catch (error) { observer({ name, state: 'approval_cancelled' }); throw error; }
    }
  };
}
module.exports = { approvalState };
