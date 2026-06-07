(function () {
  "use strict";
  if (!window.Anim) return;

  var MAX_LEVEL = 4;

  // ── model ──
  function makeList(p) {
    return {
      p: p,
      head: { key: -Infinity, height: MAX_LEVEL, next: [] },
      nodes: [],
    };
  }
  function topLevel(list) {
    return Math.max(
      1,
      list.nodes.reduce(function (m, n) {
        return Math.max(m, n.height);
      }, 0),
    );
  }
  function predecessors(list, key) {
    var update = [],
      node = list.head;
    for (var lvl = MAX_LEVEL; lvl >= 0; lvl--) {
      while (node.next[lvl] && node.next[lvl].key < key) node = node.next[lvl];
      update[lvl] = node;
    }
    return update;
  }
  function insert(list, key, height) {
    var update = predecessors(list, key);
    var n = { key: key, height: height, next: [] };
    for (var lvl = 0; lvl <= height; lvl++) {
      n.next[lvl] = update[lvl].next[lvl];
      update[lvl].next[lvl] = n;
    }
    list.nodes.push(n);
    list.nodes.sort(function (a, b) {
      return a.key - b.key;
    });
    return n;
  }
  function seed(state) {
    var list = makeList(state.p);
    state.values
      .slice()
      .sort(function (a, b) {
        return a.key - b.key;
      })
      .forEach(function (v, i, arr) {
        var h = v.height;
        if (h == null) {
          // procedural fallback when a value ships without an explicit height
          h = i % 2 === 1 ? 1 : 0;
          if (i % 4 === 3) h = 2;
          if (i === Math.floor(arr.length / 2)) h = 3;
        }
        insert(list, v.key, Math.min(h, MAX_LEVEL));
      });
    state.list = list;
  }

  var id = function (node) {
    return node.key === -Infinity ? "head" : "n" + node.key;
  };
  var name = function (node) {
    return node.key === -Infinity ? "head" : node.key;
  };
  var edgeId = function (a, b, lvl) {
    return id(a) + ">" + id(b) + "@" + lvl;
  };
  // a node occupies one addressable cell per level it lives on
  var cell = function (node, lvl) {
    return id(node) + "#" + lvl;
  };
  function tower(s, node, col, height, text, variant) {
    if (height > 0) s.rule("spine" + id(node), { col: col, fromRow: 0, toRow: height });
    for (var lvl = 0; lvl <= height; lvl++) {
      s.box(cell(node, lvl), { col: col, row: lvl, text: text, variant: variant });
    }
  }

  Anim.define("skiplist", {
    label: "Interactive skip list",
    controls: [
      {
        type: "number",
        name: "value",
        placeholder: "value",
        label: "Value",
        submit: "insert",
      },
      { type: "button", name: "insert", label: "Insert", primary: true },
      { type: "button", name: "search", label: "Search" },
      {
        type: "button",
        name: "reset",
        label: "Reset",
        muted: true,
        ariaLabel: "Reset to a fresh list",
      },
    ],

    setup: function (ctx) {
      var p = parseFloat(ctx.config("p"));
      var state = {
        p: p > 0 && p < 1 ? p : 0.5,
        // "key" or "key:height"; the default reproduces the search walkthrough
        // in the prose (42 at L3, 61 at L2, 55 at L0).
        values: ctx
          .config("values", "6:0,14:1,21:0,30:1,42:3,55:0,61:2,78:1")
          .split(",")
          .map(function (tok) {
            var parts = tok.split(":");
            return {
              key: Number(parts[0]),
              height: parts[1] != null && parts[1] !== "" ? Number(parts[1]) : null,
            };
          })
          .filter(function (v) {
            return !isNaN(v.key);
          }),
      };
      seed(state);
      ctx.status(
        "A skip list with " +
          state.values.length +
          " members. Insert a value to watch the coin flips, or search one to trace the descent.",
      );
      return state;
    },

    draw: function (ctx, state, s) {
      var list = state.list,
        levels = topLevel(list);
      list.nodes.forEach(function (n, i) {
        n.col = i + 1;
      });
      s.rows(levels + 1);
      for (var r = levels; r >= 0; r--) s.lane(r, "L" + r);

      // each node is a tower of one cell per level, joined by a spine, so the
      // descent can highlight one level at a time instead of a single big box
      tower(s, list.head, 0, levels, "H", "muted");
      list.nodes.forEach(function (n) {
        tower(s, n, n.col, n.height, n.key, null);
      });

      // forward pointers connect cells on the same level
      for (var lvl = 0; lvl <= levels; lvl++) {
        for (var node = list.head; node.next[lvl]; node = node.next[lvl]) {
          s.link(
            edgeId(node, node.next[lvl], lvl),
            cell(node, lvl),
            cell(node.next[lvl], lvl),
            { row: lvl },
          );
        }
      }
    },

    actions: {
      reset: function (ctx, state) {
        return [
          {
            commit: function () {
              seed(state);
            },
            say:
              "Reset. A fresh skip list with " +
              state.values.length +
              " members.",
          },
        ];
      },

      insert: function (ctx, state) {
        var key = ctx.number("value");
        if (key === null) return "Enter a value to insert.";
        if (
          state.list.nodes.some(function (n) {
            return n.key === key;
          })
        )
          return key + " is already in the list.";
        var h = 0,
          flips = [];
        while (Math.random() < state.list.p && h < MAX_LEVEL) {
          flips.push("heads");
          h++;
        }
        if (h < MAX_LEVEL) flips.push("tails");
        var newNode = { key: key };
        var towerCells = [];
        for (var l = 0; l <= h; l++) towerCells.push(cell(newNode, l));
        return [
          {
            say:
              "Coin flips for " +
              key +
              ": " +
              flips.join(", ") +
              " → height " +
              h +
              " (occupies levels 0–" +
              h +
              ").",
            hold: 950,
          },
          {
            commit: function () {
              insert(state.list, key, h);
            },
            found: towerCells,
            say:
              "Spliced " +
              key +
              " into " +
              (h + 1) +
              " level" +
              (h === 0 ? "" : "s") +
              ". No rotations, no rebalancing — only the predecessor pointers were rewired.",
          },
        ];
      },

      search: function (ctx, state) {
        var key = ctx.number("value");
        if (key === null) return "Enter a value to search for.";
        var list = state.list,
          levels = topLevel(list),
          node = list.head,
          steps = [];
        steps.push({
          focus: cell(node, levels),
          say: "Start at the head on level " + levels + ", the topmost express lane.",
        });
        for (var lvl = levels; lvl >= 0; lvl--) {
          while (node.next[lvl] && node.next[lvl].key < key) {
            var nx = node.next[lvl];
            steps.push({
              focus: [cell(node, lvl), cell(nx, lvl)],
              trace: edgeId(node, nx, lvl),
              say:
                "Level " +
                lvl +
                ": " +
                name(node) +
                " → " +
                nx.key +
                " (" +
                nx.key +
                " < " +
                key +
                ", advance).",
            });
            node = nx;
          }
          if (lvl > 0)
            steps.push({
              // highlight the same node's next level down — the pointer drop
              focus: cell(node, lvl - 1),
              say:
                "Level " +
                lvl +
                ": next overshoots " +
                key +
                " (or ends), drop down to level " +
                (lvl - 1) +
                ".",
              hold: 540,
            });
        }
        var target = node.next[0];
        if (target && target.key === key)
          steps.push({
            found: cell(target, 0),
            say:
              "Found " +
              key +
              " at level 0. The express lanes skipped most of the list to get here.",
          });
        else
          steps.push({
            say:
              key +
              " is not in the list. The descent stopped between " +
              name(node) +
              " and " +
              (target ? target.key : "the end") +
              ".",
          });
        return steps;
      },
    },
  });
})();
