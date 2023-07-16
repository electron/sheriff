# Sheriff: Permissions Bot

<img align="right" src="https://avatars.slack-edge.com/2019-11-21/844347353604_500f5a5483db67de7160_512.png">

This bot, when deployed as a Heroku app and configured correctly, is capable of controlling permissions
across GitHub, Slack and GSuite.  It also actively monitors and alerts you to suspicious or unexpected
activity on GitHub.

## How It Works

Using a combination of webhooks and a YAML configuration file, Sheriff will automatically control your permissions
and access controls across GitHub, Slack and GSuite.  (Slack and GSuite plugins are optional and disabled by default).

It will post to a designated Slack channel every time it updates any permission setting or any time it detects
potentially suspect actions including new deploy keys with write access, tag deletion or release branch deletion.

If you have an organization with a lot of repositories and/or org members using Sheriff can help ensure your organization remains secure and transparent.

## Deployment

We recommend deploying this as a Heroku app (this is how Electron has deployed it), although you can use another
deployment strategy if you want. There are three core components to Sheriff, all of which need to be configured
for it to work:

### The Webhook

Deploy the webhook to Heroku with this button ➡️  [![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy)

To the run the webhook server, you need to start the main Sheriff entry point.

```bash
npm start
```

You then need to create a webhook for your entire organization; you can do this on your organization's GitHub webhooks page:

https://github.com/organizations/{orgname}/settings/hooks/new

You want to specify the following options:

* `Payload URL` - The deployed URL of your webhook server, e.g. https://my-sheriff.mysite.com
* `Content type` - `application/json`
* `Secret` - Generate a random and secure secret here and save it for later in the configuration
* `Which events?` - Choose "Send me everything"

Finally, click "Add webhook".

### The GitHub App

To manage GitHub instances, Sheriff requires you to create a GitHub App that gets installed in the desired Org.

The app needs the following OAuth scopes permitted:

```
Org:
administration:write
contents:read
metadata:read

Repo:
members:write
```

Once created, you can generate and download a Private Key for the app, and supply it to Sheriff.

Before setting it as `SHERIFF_GITHUB_APP_CREDS`, you must pass it through a utility to change the format to what Octokit is expecting:

```
npx @electron/github-app-auth --creds={path-to-downloaded-private-key} --app-id={id-from-created-github-app}
```

### The Cron Job

The actual permissions controller should be triggered every 10 minutes as a cron job. You can run this job with:

```bash
node lib/permissions/run.js --do-it-for-real-this-time
```

If you leave off the `--do-it-for-real-this-time` Sheriff will "dry run" and tell you what it _would_ have done if you had let it run.

On Heroku you use the "Heroku Scheduler" addon to configure this cron job.

### The Slack App

In order to provide realtime information on the actions Sheriff takes, we use a Slack app that sends messages to a channel. You'll need to create your own Slack App by following the instructions below.

1. Create a new Slack app on https://api.slack.com/apps - Name it whatever you like and choose your workspace as the development workspace
2. Go to "Incoming Webhooks" and enable it
3. Click "Add New Webhook to Workspace" and choose the channel you want Sheriff to post in to
4. Keep a note of the newly created `Webhook URL` as you'll need it later for configuration purposes.
5. Go to "OAuth & Permissions" and add the following OAuth scopes. `usergroups:read`, `usergroups:write`, `users:read` and `users:read:email`.
6. Follow the prompt to reinstall your app for the new OAuth scopes to take effect
7. Keep a note of the `OAuth Access Token` at the top of the page as you'll need it later for configuration purposes.

## Configuration

### Service Config

The following environment variables represent the configuration of the actual Sheriff deployment. For the
`permissions.yaml` reference see the [Permissions File](#permissions-file) section.

| Name | Required | Value | For Plugin |
|------|----------|-------|------------|
| `PERMISSIONS_FILE_ORG` | ✔️ | The name of the GitHub org where you put the `.permissions` repository | |
| `PERMISSIONS_FILE_REPO` | | Override the default repo to look for `config.yaml` | `.permissions` |
| `PERMISSIONS_FILE_PATH` | | Override the default filepath to look for the Sheriff config | `config.yaml` |
| `PERMISSIONS_FILE_REF` | | Override the default repo branch to look for the Sheriff config | `main` |
| `GITHUB_WEBHOOK_SECRET` | ✔️ | The secret for the org-wide webhook you configured earlier | |
| `SLACK_TOKEN` | ✔️ | The token for your Slack App you created earlier | |
| `SLACK_WEBHOOK_URL` | ✔️ | The webhook URL for your Slack App you created earlier | |
| `SHERIFF_HOST_URL` | ✔️ | The fully qualified URL for your deployed webhook | |
| `SHERIFF_PLUGINS` | | A comma separated list of plugins to enable.  Possible plugins are `gsuite` and `slack` | |
| `SHERIFF_IMPORTANT_BRANCH` | | A regular expression to match important branches you want to monitor for deletion | |
| `SHERIFF_GITHUB_APP_CREDS` | ✔️ | Private key credentials generated for a GitHub App. ||
| `GSUITE_CREDENTIALS` | | GSuite credentials | `gsuite` |
| `GSUITE_TOKEN` | | GSuite authentication token | `gsuite` |
| `SHERIFF_GSUITE_DOMAIN` | | The primary domain of your GSuite account | `gsuite` `slack` |
| `SHERIFF_SLACK_DOMAIN` | | The "domain" part of `{domain}.slack.com` for your Slack instance  | `gsuite` if you add slack email addresses to your google groups for notifications |

### Permissions File

Your organization permissions are controlled through a `config.yaml` file stored in a `.permissions` repository
in your GitHub organization.  We keep that `.permissions` repository private but you can choose to keep it
public if you wish.  That repository needs a `config.yaml` file at the top level that is in the following format:

```yaml
organization: <name of github org>
repository_defaults:
  # Whether repositories should have wikis enabled by default or not
  # For security reasons, you should consider defaulting this to false
  has_wiki: <boolean>
# Teams are not specific to a single platform; they are shared across GitHub, Slack and GSuite
teams:
  - name: <team name>
    # A list of members / maintainers of this GitHub team
    # Maintainer in GitHub conveys some extra permissions over the team (set description, avatar, etc.)
    members:
      - list
      - of
      - gh_usernames
    maintainers:
      - list
      - of
      - gh_usernames
    # Or don't provide members/maintainers and instead provide a list of other
    # teams to draw users from.  This doesn't set any parent/child relationship
    # rather it simply says:
    # for team of formation:
    #   self.members += team.members
    #   self.maintainers += team.maintainers
    # i.e. doing a union of members/maintainers of the formation teams to create
    # a new member list
    formation:
      - list
      - of
      - other
      - teams
    # Optional team properties
    # Human friendly display name for GSuite and Slack groups
    displayName: <string>
    # Hidden GitHub team? true=yes, false=no
    secret: <boolean>
    # Create a slack user group for this team
    # false=no, true=use name of team, string=custom_name
    # Used by the `slack` plugin
    slack: <boolean> | <string>
    # Create a GSuite group for this team
    # Leave undefined for "no"
    # Used by the `gsuite` plugin
    gsuite:
      # internal = only visible to other GSuite members
      # external = public facing group email address
      privacy: internal | external
repositories:
  - name: <repo name>
    teams:
      <team_name>: read | triage | write | maintain | admin
    external_collaborators:
      <gh_username>: read | triage | write | maintain | admin
    # Optional repository settings
    settings:
      # Wiki enabled? true=yes, false=no
      has_wiki: <boolean>
    # Public vs Private repository, no value is assumed to mean public
    visibility: public | private
    # Should the repo be archived, defaults to false
    # Will unarchive the repo if changed from true to false
    archived: <boolean>
```

#### Generating your initial configuration

You can generate a permissions file for the current state of your org using the `generate` helper script.

```bash
node lib/permissions/generate.js
```

Please note you may want to edit this generated YAML file:
* All org owners are considered `maintainers` of the teams they are in, this may be semantically incorrect
* No GSuite or slack configuration is included in the generated file
* You may want to use the `formation` property to declare larger teams instead of listing all members individually

However in theory running Sheriff immediately on this generated file should result in a no-op run.

## Deployment Recommendations

You should have alerting set up in case the cron job fails. Occasionally, it will
fail due to an unexpected state on GitHub or an incorrect/incomplete permissions file.

## Known Limitations

* Sheriff is not currently capable of inviting people to your org
  * Before adding them to the permissions file, ensure you've added them to the org.
* Sheriff will not remove people from your org, if your has "default member permissions" you should ensure users are manually removed when appropriate
