import { Plugin } from "@opencode/plugin/tui";
import type { TeamflowSnapshot, StageAttempt, TeamflowCommand, MutationEnvelope } from "../../packages/protocol/src/index.js";
import { TeamflowDemo } from "../../packages/protocol/src/rpc.js";
import { MutationRetry, MutationRejectedError } from "./mutation-retry.js";

const current = (snapshot: TeamflowSnapshot, runId: string, nodeId: string) =>
  snapshot.attempts.filter(a => a.runId === runId && a.nodeId === nodeId).sort((a, b) => b.round - a.round)[0];
const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
function messageText(message: unknown) {
  if (!message || typeof message !== "object") return;
  const row = message as { type?: string; text?: string; content?: { type: string; text?: string; name?: string; state?: { status?: string } }[] };
  const text = row.text ?? row.content?.map(part => part.type === "text" ? part.text : part.type === "tool" ? `[${part.name ?? "工具"} · ${part.state?.status ?? "未知"}]` : "").filter(Boolean).join("\n");
  return text ? `${row.type ?? "原生消息"}: ${text.length > 1400 ? `${text.slice(0, 1400)}…` : text}` : undefined;
}

export default Plugin.define({
  id: "teamflow.tui",
  setup(context) {
    const [saved, updateSaved] = context.storage.store<{ pending: Record<string, MutationEnvelope> }>("pending-mutations", { initial: { pending: {} } });
    let opening = false;
    const open = async () => {
      if (opening) return;
      opening = true;
      try {
        const origin = context.ui.router.current();
        const location = context.location ?? context.data.location.default();
        const rpc = context.client.rpc(TeamflowDemo);
        const options = { location };
        const info = await rpc.info({}, options);
        if (info.directory !== location.directory) throw new Error("后端项目目录不匹配");
        const scope = { backendId: info.backendId, projectDirectory: location.directory };
        const read = () => rpc.snapshot(scope, options);
        const alert = (title: string, message: string) => context.ui.dialog.alert({ title, message });
        const scopeKey = JSON.stringify(scope);
        const mutations = new MutationRetry(scope, envelope => rpc.mutate(envelope, options), saved.pending[scopeKey], async (envelope, expectedRequestId) => {
          await updateSaved(state => {
            const existing = state.pending[scopeKey];
            if (existing && existing.requestId !== expectedRequestId) throw new Error("未决日记已由另一客户端更新；现有请求已保留，请关闭并重新打开 Teamflow 读取当前日记");
            if (envelope) state.pending[scopeKey] = envelope;
            else delete state.pending[scopeKey];
          });
        });
        const pendingDetails = () => JSON.stringify(mutations.pending, null, 2);
        const submissionError = async (error: unknown, input = "") => alert(
          error instanceof MutationRejectedError ? "后端明确拒绝（未提交）" : mutations.pending ? "提交结果未知（保留原身份）" : "本次未发送",
          `${errorText(error)}\n${input}\n${mutations.pending ? `不能重按启动当成新流程。重新打开 Teamflow 可核对/按原身份重试。\n${pendingDetails()}` : "保留上述输入；可核对后显式重新提交。"}`);
        const resolvePending = async () => {
          while (mutations.pending) {
            const envelope = mutations.pending;
            const action = await context.ui.dialog.select({
              title: `未决操作 · ${envelope.command.type} · ${envelope.requestId}`,
              options: [
                { title: "核对权威状态（不提交新操作）", value: "inspect" },
                { title: "按原 envelope / requestId 重试", value: "retry" },
                { title: "明确处理未决项后允许新操作", value: "forget", description: "原操作可能已提交；不会取消它" },
              ],
            });
            if (!action) return false;
            if (action === "inspect") {
              const snapshot = await read();
              const command = envelope.command;
              const observed = command.type === "run.start"
                ? snapshot.runs.find(r => r.id === command.payload.runId)
                : command.type === "template.import" ? snapshot.versions.find(v => v.id === command.payload.version.id) : undefined;
              await alert("权威状态 / 保留的原身份", `${pendingDetails()}\n当前 revision ${snapshot.revision}\n${observed ? JSON.stringify(observed, null, 2) : "快照未证实结果；不存在也不能证明未提交。"}\n仍可按原身份取回幂等结果。`);
            } else if (action === "retry") {
              try {
                const result = await mutations.retry();
                await alert("原身份重试响应", result.inProgress
                  ? `${result.inProgress.reason} · request ${result.inProgress.requestId}\n${result.inProgress.reason === "task_reconciliation_in_progress" ? "另一请求占用任务，本次未被接受/排队；若要操作须刷新后显式发起新请求。" : "原请求仍在进行，保留原 envelope，不创建新流程。"}`
                  : `已取得原请求结果 revision ${result.revision}。\nrequest ${envelope.requestId}\n${envelope.command.type === "run.start" ? `原 runId=${envelope.command.payload.runId}` : envelope.command.type}\n不会用此旧结果覆盖快照；查看实例时重新读取权威状态。`);
              } catch (error) { await submissionError(error); }
            } else if (await context.ui.dialog.confirm({
              title: "明确放弃原操作跟踪？",
              message: `${pendingDetails()}\n原操作可能已经提交，放弃不会取消它。修改需求/再启动是新操作，可能重复执行。请先核对原 run。`,
            })) await mutations.forget();
          }
          return true;
        };
        const openMain = async (sessionId: string) => {
          // The CLI may create a missing ID; never route without checking first.
          await rpc.sessionMessages({ scope, sessionId }, options);
          context.ui.router.navigate({ type: "session", sessionID: sessionId });
        };
        const submit = async (snapshot: TeamflowSnapshot, command: TeamflowCommand, input = "") => {
          try {
            const result = await mutations.submit(snapshot.revision, command);
            await alert("Teamflow · 后端响应", result.inProgress
              ? `未确认提交：${result.inProgress.requestId} · ${result.inProgress.reason}`
              : `已提交 revision ${result.revision}。消息入队不代表已送达或成员已确认。`);
          } catch (error) { await submissionError(error, input); }
        };
        const showChat = async (sessionId: string) => {
          while (await resolvePending()) {
            const snapshot = await read();
            const member = snapshot.members.find(m => m.sessionId === sessionId);
            const draft = snapshot.drafts.find(d => d.designer?.sessionId === sessionId);
            const task = snapshot.tasks.find(t => t.id === member?.taskId);
            const run = snapshot.runs.find(r => r.id === member?.runId);
            const canSend = !!(member && !member.legacy && task && ["running", "submitted"].includes(task.status) && !task.child?.staleBy &&
              run && !["cancelled", "failed"].includes(run.status)) || draft?.designer?.state === "ready";
            const choice = await context.ui.dialog.select({
              title: `Teamflow 私聊 · ${member?.role ?? draft?.id ?? sessionId}`,
              options: [
                { title: "读取原生会话最近消息", value: "history", description: sessionId },
                ...(member ? [{ title: "查看 Teamflow 私聊回执", value: "receipts" }] : []),
                ...(canSend ? [{ title: "发送到原会话（受控入队）", value: "send", description: run?.status === "paused" ? "暂停中，恢复后才会投递" : undefined }] : []),
              ],
            });
            if (!choice) return;
            if (choice === "history") {
              try {
                const messages = await rpc.sessionMessages({ scope, sessionId }, options);
                await alert("真实原生会话 · 最近消息", messages.map(messageText).filter(Boolean).slice(-8).join("\n\n") || "原生上下文暂无消息");
              } catch (error) { await alert("无法读取原会话（不会自动重建）", `${sessionId}\n${errorText(error)}`); }
            } else if (choice === "receipts" && member) {
              const rows = snapshot.messages.filter(m => m.runId === member.runId && (m.from === member.id || m.to === member.id));
              await alert("Teamflow 私聊回执", rows.slice(-12).map(m => `${m.from} → ${m.to} · ${m.status}${m.admission ? ` / ${m.admission}` : ""}\n${m.text.slice(0, 320)}\n${m.id}`).join("\n\n") || "尚无已登记私聊");
            } else if (choice === "send") {
              const text = await context.ui.dialog.prompt({ title: "发送消息", description: "不替代 Gate 审批；不会直接调用原生聊天模型" });
              if (!text?.trim()) continue;
              if (member) {
                const topics = snapshot.topics.filter(t => t.runId === member.runId && t.status !== "resolved" && t.participants.includes(member.id));
                const topicId = topics.length ? await context.ui.dialog.select({
                  title: "关联议题",
                  options: [{ title: "独立私聊（说明为何无关）", value: "" }, ...topics.map(t => ({ title: t.question, value: t.id }))],
                }) : "";
                if (topicId === undefined) continue;
                const unrelatedReason = !topicId && topics.length ? await context.ui.dialog.prompt({ title: "与现有议题无关的原因" }) : undefined;
                if (!topicId && topics.length && !unrelatedReason?.trim()) continue;
                await submit(await read(), { type: "message.send", payload: { runId: member.runId, toMemberId: member.id, text, ...(topicId ? { topicId } : unrelatedReason ? { unrelatedReason } : {}) } }, text);
              } else if (draft) await submit(await read(), { type: "draft.discuss", payload: { draftId: draft.id, text } }, text);
            }
          }
        };
        const chooseMember = async (snapshot: TeamflowSnapshot, runId?: string, attempt?: StageAttempt) => {
          const members = snapshot.members.filter(m => (!runId || m.runId === runId) &&
            (!attempt || snapshot.tasks.some(t => t.attemptId === attempt.id && t.memberId === m.id)));
          if (!members.length) { await alert("成员会话", "此选择没有已登记的成员会话。"); return false; }
          const session = await context.ui.dialog.select({
            title: "成员私聊（历史任务可能只读）",
            options: members.map(m => ({ title: `${m.parentMemberId ? "子成员 · " : ""}${m.role} · ${m.id}`, description: `${m.runId} · ${m.sessionId}`, value: m.sessionId })),
          });
          if (session) { await showChat(session); return true; }
          return false;
        };
        const showTopics = async (snapshot: TeamflowSnapshot, runId: string) => {
          const topics = snapshot.topics.filter(t => t.runId === runId);
          if (!topics.length) { await alert("团队议题", "暂无议题。可在 Teamflow 网页发起议题或记录结论。"); return; }
          const topicId = await context.ui.dialog.select({ title: "团队议题", options: topics.map(t => ({
            title: t.question, description: `第 ${t.round} 轮 · ${t.status}`, value: t.id,
          })) });
          const topic = topics.find(t => t.id === topicId);
          if (!topic) return;
          await alert(`议题 · ${topic.status}`, [
            topic.question, `参与成员：${topic.participants.join(", ")}`,
            ...topic.responses.map(r => `第 ${r.round ?? 1} 轮 · ${r.memberId}：${r.text}`),
            topic.conclusion && `结论（不是批准）：${topic.conclusion}`, topic.escalationReason,
          ].filter(Boolean).join("\n\n"));
        };
        const showQuestions = async (snapshot: TeamflowSnapshot, runId: string) => {
          const questions = snapshot.questions.filter(q => q.runId === runId).reverse();
          if (!questions.length) { await alert("成员提问", "暂无成员提问。"); return; }
          const status = { open: "等待答复", answered: "已答复", superseded: "已失效" } as const;
          const id = await context.ui.dialog.select({ title: "成员提问", options: questions.map(q => ({
            title: q.question, description: `${snapshot.members.find(m => m.id === q.memberId)?.role ?? q.memberId} · ${status[q.status]}`, value: q.id,
          })) });
          const q = questions.find(q => q.id === id);
          if (!q) return;
          if (q.status !== "open") {
            await alert(`成员提问 · ${status[q.status]}`, `${q.question}\n\n${q.answer ?? "未答复"}`); return;
          }
          const answer = await context.ui.dialog.prompt({
            title: "回复成员", description: `${q.question}\n回复只发给提问者（${q.memberId}），不代表方案确认或验收。`,
          });
          if (!answer?.trim()) return;
          const fresh = await read();
          if (!fresh.questions.some(x => x.id === q.id && x.status === "open")) {
            await alert("问题已变化，未发送", answer); return;
          }
          await submit(fresh, { type: "question.answer", payload: { questionId: q.id, answer } }, answer);
        };
        const showNode = async (runId: string, nodeId: string) => {
          // Each return to a node reads fresh authority, including catalog changes at the same revision.
          let savedReason = "";
          while (true) {
            if (!await resolvePending()) return;
            const snapshot = await read();
            const run = snapshot.runs.find(r => r.id === runId);
            const version = snapshot.versions.find(v => v.id === run?.versionId);
            const node = version?.graph.nodes.find(n => n.id === nodeId);
            const attempt = current(snapshot, runId, nodeId);
            if (!run || !node || !attempt) throw new Error("流程、节点或当前轮次已不存在；请重新选择");
            const source = node.sourceNodeId ? current(snapshot, runId, node.sourceNodeId) : attempt;
            const delivery = snapshot.deliveries.findLast(d => d.attemptId === source?.id);
            const relevant = snapshot.approvals.filter(a => a.runId === runId && (a.attemptId === attempt.id || a.targetAttemptId === source?.id));
            const tasks = snapshot.tasks.filter(t => t.runId === runId && t.attemptId === attempt.id);
            const history = snapshot.attempts.filter(a => a.runId === runId && a.nodeId === nodeId && a.id !== attempt.id);
            const action = await context.ui.dialog.select({
              title: `${node.name} · ${attempt.status} · 第${attempt.round}轮`,
              options: [
                { title: "当前节点与任务状态", value: "state", description: `attempt ${attempt.id}` },
                { title: "交付、检查与审批证据", value: "evidence", description: delivery ? `delivery ${delivery.id}` : "尚无当前源交付" },
                { title: "历史轮次", value: "history", description: `${history.length} 条` },
                { title: "打开此节点的成员会话", value: "member" },
                ...(node.kind === "gate" && node.gate?.user && attempt.status === "awaiting_gate" && delivery ? [
                  { title: "用户批准此 Gate", value: "approve" },
                  { title: "用户打回此 Gate", value: "reject" },
                ] : []),
                { title: "刷新此节点", value: "refresh" },
              ],
            });
            if (!action) return;
            if (action === "state") {
              await alert("节点状态", `run ${run.id} · ${run.status}\nnode ${node.id} · ${node.kind}\nattempt ${attempt.id} · ${attempt.status} · round ${attempt.round}\n${attempt.reason ?? ""}\n${tasks.map(t => `task ${t.id}: ${t.status}, slotHeld=${t.slotHeld}${t.error ? `, ${t.error}` : ""}\n${t.inspection ? `inspection: ${JSON.stringify(t.inspection)}\n` : ""}${t.reconciliation ? `reconciliation: ${JSON.stringify(t.reconciliation)}` : ""}`).join("\n") || "无派工"}`);
            } else if (action === "evidence") {
              const entries = [
                ...(delivery ? [{ title: `源交付 ${delivery.id}`, value: `源 attempt ${delivery.attemptId}\n产物 ${delivery.artifactRevision}\n标准 ${delivery.criteriaRevision}\n摘要 ${delivery.summary}\n文件 ${delivery.artifacts.join(", ")}\n未解决 ${delivery.unresolved.join(", ") || "无"}${delivery.confirmedQuestions?.map(q => `\n问题：${q.question}\n已确认：${q.answer}`).join("\n") ?? ""}` }, ...delivery.checks.map((check, i) => ({ title: `自检 ${i + 1} · exit ${check.exitCode}`, value: JSON.stringify(check, null, 2) }))] : []),
                ...relevant.map(a => ({ title: `${a.kind} ${a.verdict} · ${a.valid ? "有效" : "历史失效"}`, value: JSON.stringify(a, null, 2) })),
              ];
              if (!entries.length) { await alert("证据", "当前尚无源交付或审批证据。"); continue; }
              const entry = await context.ui.dialog.select({ title: "交付与检查证据", options: entries });
              if (entry) await alert("证据详情", entry);
            } else if (action === "history") {
              await alert("历史轮次", history.map(a => `第${a.round}轮 ${a.status} · ${a.id}\n${a.reason ?? ""}`).join("\n") || "无历史轮次");
            } else if (action === "member") {
              if (await chooseMember(snapshot, runId, attempt)) return true;
            } else if (action === "approve" || action === "reject") {
              if (!delivery) continue;
              let reason = "";
              if (action === "reject") {
                const input = await context.ui.dialog.prompt({ title: "打回理由", description: "明确说明返工要求", value: savedReason });
                if (!input?.trim()) continue;
                reason = savedReason = input;
              }
              const binding = { attemptId: attempt.id, deliveryId: delivery.id, artifactRevision: delivery.artifactRevision, criteriaRevision: delivery.criteriaRevision };
              const fresh = await read();
              const freshAttempt = current(fresh, runId, nodeId);
              const freshSource = node.sourceNodeId ? current(fresh, runId, node.sourceNodeId) : undefined;
              const freshDelivery = fresh.deliveries.findLast(d => d.attemptId === freshSource?.id);
              if (freshAttempt?.id !== binding.attemptId || freshAttempt.status !== "awaiting_gate" || !freshDelivery || freshDelivery.id !== binding.deliveryId || freshDelivery.artifactRevision !== binding.artifactRevision || freshDelivery.criteriaRevision !== binding.criteriaRevision) {
                await alert("状态已变化", `本次未提交。请重新查看证据。${reason ? `\n已输入理由：${reason}` : ""}`); continue;
              }
              const confirmed = await context.ui.dialog.confirm({
                title: action === "approve" ? "明确批准此交付？" : "明确打回此交付？",
                message: `run ${runId}\nnode ${nodeId}\nattempt ${binding.attemptId}\ndelivery ${binding.deliveryId}\nartifact ${binding.artifactRevision}\ncriteria ${binding.criteriaRevision}${reason ? `\n理由 ${reason}` : ""}\n仅对所列交付作出决定。`,
                label: { confirm: action === "approve" ? "批准" : "打回", cancel: "取消" },
              });
              if (!confirmed) continue;
              const command: TeamflowCommand = action === "approve" ? { type: "gate.approve", payload: binding } : { type: "gate.reject", payload: { ...binding, reason } };
              try {
                const result = await mutations.submit(fresh.revision, command);
                if (result.inProgress) {
                  await alert("操作进行中", `request ${result.inProgress.requestId} · ${result.inProgress.reason}\n不表示本次操作已成功或排队。${reason ? `\n理由：${reason}` : ""}`);
                } else {
                  savedReason = "";
                  try {
                    const after = await read();
                    const actual = current(after, runId, nodeId);
                    await alert("后端状态", `revision ${after.revision}\n当前 attempt ${actual?.id ?? "无"}\n状态 ${actual?.status ?? "未知"}${result.resyncRequired ? "\n通知未送达；已重新读取。" : ""}`);
                  } catch (error) {
                    await alert("操作已提交，刷新失败", `请勿盲目重复。${errorText(error)}`);
                  }
                }
              } catch (error) {
                await submissionError(error);
              }
            }
          }
        };
        const showRun = async (runId: string) => {
          while (true) {
            if (!await resolvePending()) return;
            const snapshot = await read();
            const run = snapshot.runs.find(r => r.id === runId);
            const version = snapshot.versions.find(v => v.id === run?.versionId);
            if (!run || !version) throw new Error("流程或版本不存在");
            const nodeId = await context.ui.dialog.select({
              title: `${run.label} · ${run.status}${run.entry?.state === "pending" ? " · 主会话准备中" : ""}${run.waitingReason ? ` · ${run.waitingReason}` : ""}`,
              options: [
                { title: "成员提问与答复", value: ":questions", description: `${snapshot.questions.filter(q => q.runId === runId && q.status === "open").length} 个待答` },
                { title: "成员私聊", value: ":members" },
                { title: "团队议题", value: ":topics" },
                ...(run.entry ? [{ title: run.entry.state === "ready" ? "打开原生团队主会话" : "核对主会话准备状态", value: ":main", description: run.entry.sessionId }] : []),
                ...(run.status === "paused" ? [{ title: "恢复调度", value: ":resume" }]
                  : ["running", "waiting"].includes(run.status) ? [{ title: "暂停调度", value: ":pause" }] : []),
                ...version.graph.nodes.map(node => {
                  const a = current(snapshot, runId, node.id);
                  return { title: `${node.name} · ${a?.status ?? "无状态"} · 第${a?.round ?? "?"}轮`, description: `${node.id} · ${node.kind}`, value: node.id };
                }),
              ],
            });
            if (!nodeId) return;
            if (nodeId === ":questions") await showQuestions(snapshot, runId);
            else if (nodeId === ":members") await chooseMember(snapshot, runId);
            else if (nodeId === ":topics") await showTopics(snapshot, runId);
            else if (nodeId === ":main" && run.entry) {
              if (run.entry.state === "ready") { await openMain(run.entry.sessionId); return; }
              await alert("原生团队主会话尚未就绪", `${run.entry.sessionId}\n${run.entry.error ?? "后端正在核对此 ID，不会另建入口。"}`);
            }
            else if (nodeId === ":pause" || nodeId === ":resume") await submit(snapshot, { type: nodeId === ":pause" ? "run.pause" : "run.resume", payload: { runId } });
            else if (await showNode(runId, nodeId)) continue;
          }
        };
        if (!await resolvePending()) return;
        const snapshot = await read();
        const linked = origin.type === "session" ? snapshot.runs.filter(r => r.entry?.sessionId === origin.sessionID) : [];
        const currentRun = linked.findLast(r => ["running", "waiting", "paused"].includes(r.status)) ?? linked.at(-1);
        const action = await context.ui.dialog.select({
          title: `Teamflow · ${scope.backendId} · ${scope.projectDirectory}`,
          options: [
            ...(currentRun ? [{ title: `此主会话的团队 · ${currentRun.label}`, value: "current" }] : []),
            { title: "查看实例与成员", value: "runs" },
            { title: "启动流程", value: "start", description: origin.type === "session" ? "绑定当前原生主聊天" : "创建一个 Teamflow 主入口" },
             { title: "打开现有成员会话", value: "members" },
             { title: "打开独立流程设计会话", value: "designers" },
          ],
        });
         if (action === "members") await chooseMember(snapshot);
         else if (action === "designers") {
           const sessionId = await context.ui.dialog.select({
             title: "持久化草稿的真实设计 session（缺失不重建）",
             options: snapshot.drafts.filter(d => d.designer).map(d => ({ title: `${d.id} · rev ${d.revision} · ${d.designer!.state}`, description: d.designer!.sessionId, value: d.designer!.sessionId })),
           });
            if (sessionId) await showChat(sessionId);
          }
        else if (action === "current" && currentRun) await showRun(currentRun.id);
        else if (action === "runs") {
          const runId = await context.ui.dialog.select({ title: "流程实例", options: snapshot.runs.map(run => ({ title: `${run.label} · ${run.status}`, description: `${run.id} ${run.waitingReason ?? ""}`, value: run.id })) });
          if (runId) await showRun(runId);
        } else if (action === "start") {
          const versionId = await context.ui.dialog.select({ title: "选择已发布版本", options: snapshot.versions.map(version => ({ title: `${snapshot.templates.find(template => template.id === version.templateId)?.name ?? version.templateId} · ${version.id}`, value: version.id })) });
          if (!versionId) return;
          const label = await context.ui.dialog.prompt({ title: "流程需求摘要" });
          if (!label?.trim()) return;
          const brief = await context.ui.dialog.prompt({ title: "任务说明（可选）" });
          if (brief === undefined) return;
          const fresh = await read();
          if (!await context.ui.dialog.confirm({ title: "启动真实流程？", message: `${versionId}\n${label}\n${brief}\n${origin.type === "session" ? "绑定当前聊天，不另建原生主会话。" : "将创建唯一的原生团队主入口。"}成员在 Teamflow 中私聊。` })) return;
          try {
            const runId = `run-${crypto.randomUUID()}`;
            const result = await mutations.submit(fresh.revision, { type: "run.start", payload: { runId, versionId, label, ...(brief ? { brief } : {}), ...(origin.type === "session" ? { mainSessionId: origin.sessionID } : {}) } });
            await alert("后端响应", result.inProgress ? `操作进行中：${result.inProgress.requestId}；并不表示本次已排队。\n${label}\n${brief}` : `已提交，revision ${result.revision}。请刷新查看实际状态。${result.resyncRequired ? "\n通知未送达，请勿重复启动。" : ""}`);
            if (!result.inProgress) await showRun(runId);
          } catch (error) { await submissionError(error, `需求摘要：${label}\n任务说明：${brief}`); }
        }
      } catch (error) {
        await context.ui.dialog.alert({ title: "Teamflow 错误", message: errorText(error) });
      } finally { opening = false; }
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{ id: "teamflow.open", title: "Teamflow 流程", group: "Teamflow", palette: true, slash: { name: "teamflow" }, run: open }],
    }));
  },
});
