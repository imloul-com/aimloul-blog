---
title: "Managing Multiple GitHub Accounts with gh CLI and direnv"
date: 2026-05-07
author: "Imloul Anas"
tags: ["git", "github", "cli", "productivity", "macos"]
draft: false
---

I juggle a few GitHub accounts on the same laptop (work, personal, the occasional client repo), and `gh auth login` with the 8-character browser dance every time I switch context was wearing me down.

Here's the setup I landed on for macOS. Each project automatically uses the right account when I `cd` into it.

## The problem

`gh auth login` is fine the first time you set things up. Doing it every time you change projects, less fine. `gh auth switch` is quicker but you have to remember to run it, and at some point you forget and push to the wrong place.

There's also a sharper issue. Since `gh` 2.24 (Feb 2023), OAuth tokens live in the system keyring on macOS, not in `~/.config/gh/hosts.yml`. So you can't just copy the config directory to clone an account, because the secrets aren't actually in the files. `gh auth switch` also flips a single "active slot" pointer in the keychain, which means two terminals pointing at different `GH_CONFIG_DIR`s can still trip over each other.

What I wanted: `cd` into a project and have the right account ready, without leaning on shared keychain state.

## The solution

One Personal Access Token per account, plus `direnv` to export the right `GH_TOKEN` for each project. Both `gh` and `git` prefer `GH_TOKEN` over anything they have stored, so each shell ends up seeing exactly one account.

{{< callout title="Why not just copy ~/.config/gh?" type="info" >}}
On recent `gh` (≥2.24), tokens live in the OS keyring. Copying the config directory gets you `hosts.yml` and `config.yml` but not the credentials, so the copies won't authenticate. `gh auth login --insecure-storage` is a workaround that writes tokens to `hosts.yml` in cleartext, and I've covered that variant at the bottom.
{{< /callout >}}

## Step 1: Create one Personal Access Token per account

For each account, generate a fine-grained PAT at <https://github.com/settings/personal-access-tokens>. Pick whichever repo and workflow scopes you actually need, set an expiry you're comfortable with, and stash the token in a password manager. Not a text file on your desktop.

You should end up with one `ghp_…` or `github_pat_…` string per account.

## Step 2: Install direnv and hook it into your shell

{{< codeblock label="Install direnv" labeltype="neutral" lang="bash" >}}
brew install direnv
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc
source ~/.zshrc
{{< /codeblock >}}

On bash, swap `zsh` for `bash` and `~/.zshrc` for `~/.bashrc`.

Quick sanity check that the hook is live:

{{< codeblock label="Hook check" labeltype="neutral" lang="bash" >}}
type _direnv_hook
{{< /codeblock >}}

If you get "not found", the hook isn't active yet. Re-source your shell config, or just open a fresh terminal.

## Step 3: Store tokens outside your repos

Each token goes in its own file under `~/.config/gh-tokens/`. These files don't live anywhere near a git repo.

{{< codeblock label="Create token files" labeltype="neutral" lang="bash" >}}
mkdir -p ~/.config/gh-tokens
chmod 700 ~/.config/gh-tokens

# Paste each token into its own file
printf '%s' 'ghp_xxxxxxxxxxxxxxxxxxxx' > ~/.config/gh-tokens/work
printf '%s' 'ghp_yyyyyyyyyyyyyyyyyyyy' > ~/.config/gh-tokens/personal
printf '%s' 'ghp_zzzzzzzzzzzzzzzzzzzz' > ~/.config/gh-tokens/clientx

chmod 600 ~/.config/gh-tokens/*
{{< /codeblock >}}

{{< callout title="Why not put the token directly in .envrc?" type="info" >}}
A token sitting in `.envrc` is one stray `git add .` away from being committed. I've seen people forget the gitignore, clone the repo on another machine, and `cat .envrc` not realising what's in it. Keeping tokens in `~/.config/gh-tokens/` and only pointing at the path from `.envrc` means the project file holds no secret and is harmless if it leaks.
{{< /callout >}}

## Step 4: Drop a `.envrc` in each project

In the root of every project, add a `.envrc` that reads the right token file:

{{< codeblock label="Wire up a project" labeltype="neutral" lang="bash" >}}
cd ~/projects/work-stuff
cat > .envrc <<'EOF'
export GH_TOKEN="$(cat ~/.config/gh-tokens/work)"
export GITHUB_TOKEN="$GH_TOKEN"   # so git's credential helper picks it up too
EOF
direnv allow
{{< /codeblock >}}

Same idea for personal and client projects, just swap the token filename.

{{< callout title="Why direnv allow?" type="info" >}}
direnv won't load an `.envrc` until you explicitly approve it. That's what stops a random repo from silently exporting variables into your shell. You'll need to re-allow after every edit, which feels annoying for about a week and then becomes invisible.
{{< /callout >}}

## Step 5: Verify

{{< codeblock label="Smoke test" labeltype="good" lang="bash" >}}
cd ~/projects/work-stuff
gh auth status        # should show: Logged in to github.com as <work-username> (GH_TOKEN)
gh api user --jq .login   # confirms which account gh is actually acting as
{{< /codeblock >}}

You'll see `direnv: loading .envrc` when you enter the directory and `direnv: unloading` when you leave. If `gh auth status` is showing the wrong account, `GH_TOKEN` probably isn't set. Run `echo ${GH_TOKEN:+set}` to check (it'll print `set`, and won't leak the actual token).

## Step 6: Make `git push` follow the same account

`git` doesn't read `GH_TOKEN` directly. The simplest workaround is to let `gh` act as git's credential helper:

{{< codeblock label="One-time git setup" labeltype="neutral" lang="bash" >}}
gh auth setup-git
{{< /codeblock >}}

After that, `git push` over HTTPS will use whatever token `gh` ends up resolving, which means `GH_TOKEN` when it's set. Switching directories switches the account git pushes as.

If you prefer SSH, configure per-host SSH keys in `~/.ssh/config` instead. `GH_TOKEN` only handles the `gh` API side; SSH config handles git-over-SSH. The two don't talk to each other.

## Tips

**Group projects by parent folder.** If your layout looks like `~/projects/work/` and `~/projects/personal/`, put one `.envrc` at the parent level. direnv walks up the directory tree, so every subproject inherits it. I do this and it removes most of the per-repo bookkeeping.

**Add `.envrc` to your global gitignore** anyway, even though it contains no secret. Cheap insurance:

{{< codeblock label="Global gitignore" labeltype="neutral" lang="bash" >}}
echo '.envrc' >> ~/.gitignore_global
git config --global core.excludesfile ~/.gitignore_global
{{< /codeblock >}}

**Rotate tokens on a schedule.** Fine-grained PATs expire on a date you pick, so set 90 days and add a calendar reminder. When the time comes, rotation is just one `printf > ~/.config/gh-tokens/<account>`. No need to touch `.envrc` files.

**Check what `gh` falls back to.** Outside any direnv-managed directory, `GH_TOKEN` is unset and `gh` reads from the keyring. Running `gh auth status` from `~` is a quick way to see your default.

## Troubleshooting

**`.envrc` not loading?**

- `type _direnv_hook`. If it says "not found", the shell hook isn't installed. Add it back to your shell config and reload.
- Make sure you actually ran `direnv allow` after the last edit.

**`gh auth status` shows the wrong account?**

- Is `GH_TOKEN` set in this shell? `echo ${GH_TOKEN:+set}` should print `set`.
- The token file might be empty, or have a trailing newline. Rewrite it with `printf '%s'` rather than `echo`.

**`gh` says "Bad credentials"?**

- The PAT has probably expired, been revoked, or doesn't have the scope the command needs. Regenerate it and overwrite the token file.
- If you're not sure the token even loaded, run `gh api user`. It'll fail with a specific reason.

**`git push` still prompting for credentials?**

- Either you haven't run `gh auth setup-git`, or the remote is SSH. In the SSH case `GH_TOKEN` doesn't matter at all and you want to look at `~/.ssh/config`.
