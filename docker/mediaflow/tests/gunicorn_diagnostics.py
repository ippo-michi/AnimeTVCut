"""Capture blocked worker stacks when an integration run stalls."""

import faulthandler


def post_worker_init(worker):
    faulthandler.dump_traceback_later(30, repeat=True)


def worker_abort(worker):
    faulthandler.dump_traceback(all_threads=True)
