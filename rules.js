export const ruleNames = {
  points: "得点制",
  "seven-three": "7○3×",
  survival: "ライフバトル",
};

export function evaluateGame(room) {
  const stats = new Map(
    [...room.players.values()].map((p) => [
      p.id,
      {
        correct: 0,
        wrong: 0,
        lives: room.settings.startingLives,
        status:
          p.id === room.hostId ? "host" : p.spectator ? "spectator" : "active",
      },
    ]),
  );
  for (const result of room.results) {
    const player = stats.get(result.id);
    if (player && !["host", "spectator"].includes(player.status))
      player[result.correct ? "correct" : "wrong"]++;
    for (const [id, damage] of Object.entries(result.lifeLoss)) {
      const target = stats.get(id);
      if (target && !["host", "spectator"].includes(target.status))
        target.lives = Math.max(0, target.lives - damage);
    }
  }
  const participants = [...stats.entries()].filter(
    ([, p]) => !["host", "spectator"].includes(p.status),
  );
  const winnerIds = [];
  for (const [id, p] of participants) {
    if (room.settings.rule === "seven-three") {
      if (p.correct >= 7) {
        p.status = "won";
        winnerIds.push(id);
      } else if (p.wrong >= 3) p.status = "eliminated";
    } else if (room.settings.rule === "survival" && p.lives === 0)
      p.status = "eliminated";
  }
  const active = participants.filter(([, p]) => p.status === "active");
  let finished =
    room.settings.rule !== "points" &&
    (winnerIds.length > 0 ||
      (room.matchStarted && participants.length > 0 && active.length === 0));
  if (
    room.settings.rule === "survival" &&
    room.matchStarted &&
    room.hadCompetition &&
    active.length <= 1
  ) {
    finished = true;
    if (active.length) {
      active[0][1].status = "won";
      winnerIds.push(active[0][0]);
    }
  }
  return {
    stats,
    game: {
      rule: room.settings.rule,
      status: finished ? "finished" : room.matchStarted ? "playing" : "waiting",
      winners: winnerIds.map((id) => ({ id, name: room.players.get(id).name })),
      draw: finished && winnerIds.length === 0,
    },
  };
}

export function lifeLossForJudgment(room, id, correct, stats) {
  if (room.settings.rule !== "survival") return {};
  if (!correct) return { [id]: room.settings.wrongLifeLoss };
  return Object.fromEntries(
    [...stats.entries()]
      .filter(
        ([target, p]) => target !== id && p.status === "active" && p.lives > 0,
      )
      .map(([target]) => [target, room.settings.lifeDamage]),
  );
}
