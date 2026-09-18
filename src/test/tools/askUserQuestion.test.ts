import * as assert from 'assert';
import { AskUserQuestionExecutor } from '../../tools/executors/askUserQuestion';

/**
 * Regression coverage for the question-dialog fix: the tool must WAIT for the
 * user (no 120s auto-answer), cancel cleanly when the turn is aborted, dismiss
 * its card, and never wipe other pending questions on failure.
 */

interface Posted { command: string; questionId?: string; [k: string]: unknown; }

function fakeWebview() {
    const posted: Posted[] = [];
    const webview = { postMessage: async (msg: Posted) => { posted.push(msg); return true; } };
    return { posted, webview };
}

/** The questionId the executor generated, read from its showQuestion post. */
function questionIdOf(posted: Posted[]): string {
    const shown = posted.find(m => m.command === 'showQuestion');
    assert.ok(shown, 'expected a showQuestion message');
    return String(shown!.questionId);
}

suite('AskUserQuestionExecutor', () => {
    test('resolves with the user answer when answered', async () => {
        const exec = new AskUserQuestionExecutor();
        const { webview, posted } = fakeWebview();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec.setWebview(webview as any);

        const p = exec.execute({ question: 'Pick one', options: [{ label: 'A', description: '' }] });
        await new Promise(r => setImmediate(r));
        const qid = questionIdOf(posted);

        exec.resolveQuestion(qid, 'A');
        const result = await p;

        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.output).response, 'A');
        assert.strictEqual(JSON.parse(result.output).cancelled, false);
        assert.ok(posted.some(m => m.command === 'removeQuestion' && m.questionId === qid), 'card dismissed after answering');
    });

    test('does not auto-answer — stays pending until the user acts', async () => {
        const exec = new AskUserQuestionExecutor();
        const { webview } = fakeWebview();
        const ac = new AbortController();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec.setWebview(webview as any);
        // Wire an abort signal up front so we can cleanly end the test.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec.setAbortSignal(ac.signal as any);

        let settled = false;
        const p = exec.execute({ question: 'Waits' }).then(r => { settled = true; return r; });

        await new Promise(r => setTimeout(r, 60));
        assert.strictEqual(settled, false, 'the question must not answer itself on a timer');

        ac.abort();          // clean up: cancel the pending question
        await p;
    });

    test('cancels cleanly when the turn is aborted', async () => {
        const exec = new AskUserQuestionExecutor();
        const { webview, posted } = fakeWebview();
        const ac = new AbortController();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec.setWebview(webview as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec.setAbortSignal(ac.signal as any);

        const p = exec.execute({ question: 'Cancel me' });
        await new Promise(r => setImmediate(r));

        ac.abort();
        const result = await p;

        assert.strictEqual(result.success, false);
        assert.strictEqual(JSON.parse(result.output).cancelled, true);
        assert.ok(result.error && result.error.includes('did not answer'), 'model is told not to assume an answer');
        assert.ok(posted.some(m => m.command === 'removeQuestion'), 'card dismissed on cancel');
    });

    test('answering resolves only the matching question, leaving others pending', async () => {
        // Two questions tracked concurrently on one executor instance. Answering
        // one must not disturb the other (the old code cleared ALL pending on any
        // failure). No abort signal here, so an unanswered question stays pending.
        const exec = new AskUserQuestionExecutor();
        const { webview, posted } = fakeWebview();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec.setWebview(webview as any);

        const p1 = exec.execute({ question: 'Q1' });
        await new Promise(r => setImmediate(r));
        const qid1 = String(posted.filter(m => m.command === 'showQuestion')[0].questionId);

        const p2 = exec.execute({ question: 'Q2' });
        await new Promise(r => setImmediate(r));
        const qid2 = String(posted.filter(m => m.command === 'showQuestion')[1].questionId);
        assert.notStrictEqual(qid1, qid2);

        // Answer Q2; Q1 must remain pending and independently answerable.
        exec.resolveQuestion(qid2, 'answer-2');
        const r2 = await p2;
        assert.strictEqual(JSON.parse(r2.output).response, 'answer-2');

        let p1Settled = false;
        void p1.then(() => { p1Settled = true; });
        await new Promise(r => setTimeout(r, 30));
        assert.strictEqual(p1Settled, false, 'Q1 must survive Q2 being answered');

        // Now answer Q1 to confirm it was still wired, and to clean up.
        exec.resolveQuestion(qid1, 'answer-1');
        const r1 = await p1;
        assert.strictEqual(JSON.parse(r1.output).response, 'answer-1');
    });
});
