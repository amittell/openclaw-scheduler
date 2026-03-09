import { db, jobs, shellResults, type RunRecord } from './index.js';

void db.getResolvedDbPath();

const job = jobs.validateJobSpec({
  name: 'Type smoke',
  schedule_cron: '0 0 31 2 *',
  payload_message: 'echo ok',
  session_target: 'shell',
  payload_kind: 'shellCommand',
});

const fakeRun: RunRecord = {
  id: 'run-1',
  job_id: 'job-1',
  status: 'error',
  shell_stdout: 'stdout',
  shell_stderr: 'stderr',
};

void job;
void fakeRun;
void shellResults.DEFAULT_STORE_LIMIT;
