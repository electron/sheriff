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
    members:
      - list
      - of
      - gh_usernames
    maintainers:
      - list
      - of
      - gh_usernames
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
    # Public vs Private repository, no value is assumed to mean public
    visibility: public | private
```

## Deployment Recommendations

You should have alerting set up in case the cron job fails. Occasionally, it will
fail due to an unexpected state on GitHub or an incorrect/incomplete permissions file.

## Known Limitations

* Sheriff is not currently capable of inviting people to your org
  * Before adding them to the permissions file, ensure you've added them to the org.
* Sheriff will not remove people from your org, if your has "default member permissions" you should ensure users are manually removed when appropriate
