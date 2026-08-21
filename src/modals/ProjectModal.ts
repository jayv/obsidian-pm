import { App, ButtonComponent, Modal, Notice } from 'obsidian'
import type PMPlugin from '../main'
import { Project, CustomFieldDef, makeId, makeProject } from '../types'
import { rebuildTaskIndex } from '../store'
import { safeAsync } from '../utils'
import { Avatar } from '../ui/primitives/Avatar'
import { projectRoster } from '../ui/roster'

const PROJECT_COLORS = [
  '#8b72be',
  '#7c6b9a',
  '#b07d9e',
  '#c47070',
  '#b8a06b',
  '#79b58d',
  '#6ba8a0',
  '#7a9ec4',
  '#767491',
  '#8aab6b'
]

const PROJECT_ICONS = ['📋', '🚀', '💡', '🎯', '🔬', '🏗', '📊', '🎨', '📱', '🛠', '📝', '⚡']

/**
 * Project create/edit modal.
 *
 * Obsidian renders modals outside `.pm-root` in the DOM. We apply `.pm-modal`
 * to re-declare `--pm-*` CSS variables, then use CSS classes from styles.css.
 * Remaining inline styles are only for dynamic runtime values (computed colors,
 * avatar hashes, display toggles) that cannot be expressed in static CSS.
 */
export class ProjectModal extends Modal {
  private project: Project
  private isNew: boolean
  /** Serialized project at open, to detect edits and auto-persist only when changed. */
  private snapshot = ''
  /** Set once the project has been written (explicit create, or auto-persist on close). */
  private saved = false

  constructor(
    app: App,
    private plugin: PMPlugin,
    existingProject: Project | null,
    private onSave: (project: Project) => void | Promise<void>
  ) {
    super(app)
    if (existingProject) {
      this.project = JSON.parse(JSON.stringify(existingProject)) as Project
      // The JSON round-trip turns the taskIndex Map into a plain object.
      rebuildTaskIndex(this.project)
      this.isNew = false
    } else {
      this.project = makeProject('New Project', '')
      this.isNew = true
    }
    this.snapshot = JSON.stringify(this.project)
  }

  onOpen(): void {
    this.modalEl.addClass('pm-modal', 'pm-modal--project')
    const el = this.contentEl
    el.empty()
    el.addClass('pm-project-modal')
    this.buildForm(el)
  }

  onClose(): void {
    this.contentEl.empty()
    // Auto-persist edits to an existing project (no Save button). New projects use
    // the explicit create action, so don't auto-create one on dismiss.
    const changed = JSON.stringify(this.project) !== this.snapshot
    if (!this.isNew && !this.saved && changed && this.project.title.trim()) {
      void this.persist()
    }
  }

  private async persist(): Promise<void> {
    this.saved = true
    await this.plugin.store.saveProject(this.project)
    await this.onSave(this.project)
  }

  /** Re-render the whole modal (e.g. after a connector mutates shared project fields). */
  private rerender(): void {
    this.contentEl.empty()
    this.buildForm(this.contentEl)
  }

  private buildForm(el: HTMLElement): void {
    // ── Header ────────────────────────────────────────────────────────────────
    const header = el.createDiv('pm-project-modal-header')
    header.createSpan({ text: '✦', cls: 'pm-project-modal-header-icon' })
    header.createEl('h2', {
      text: this.isNew ? 'New project' : 'Project settings',
      cls: 'pm-modal-heading'
    })

    // ── Icon + Title ──────────────────────────────────────────────────────────
    const topRow = el.createDiv('pm-project-top-row')

    // Icon picker
    const iconWrap = topRow.createDiv('pm-icon-picker')
    const iconBtn = iconWrap.createEl('button', { text: this.project.icon, cls: 'pm-icon-picker-btn' })

    const iconGrid = iconWrap.createDiv('pm-icon-grid')
    iconGrid.addClass('pm-hidden')
    for (const emoji of PROJECT_ICONS) {
      const btn = iconGrid.createEl('button', { text: emoji, cls: 'pm-icon-option' })
      btn.addEventListener('click', () => {
        this.project.icon = emoji
        iconBtn.textContent = emoji
        iconGrid.addClass('pm-hidden')
      })
    }
    iconBtn.addEventListener('click', () => {
      iconGrid.toggleClass('pm-hidden', !iconGrid.hasClass('pm-hidden'))
    })

    // Title
    const titleWrap = topRow.createDiv('pm-project-title-wrap')
    titleWrap.createEl('label', { text: 'Project name', cls: 'pm-label' })
    const titleInput = titleWrap.createEl('input', {
      type: 'text',
      value: this.project.title,
      cls: 'pm-input pm-input--lg'
    })
    titleInput.placeholder = 'My awesome project'
    titleInput.addEventListener('input', () => {
      this.project.title = titleInput.value
    })
    window.setTimeout(() => {
      titleInput.focus()
      titleInput.select()
    }, 50)

    // ── Color ─────────────────────────────────────────────────────────────────
    const colorSection = el.createDiv('pm-project-modal-section')
    colorSection.createEl('label', { text: 'Color', cls: 'pm-label' })
    const colorPalette = colorSection.createDiv('pm-color-palette')
    for (const color of PROJECT_COLORS) {
      const swatch = colorPalette.createEl('button', { cls: 'pm-color-swatch' })
      swatch.setCssStyles({ background: color })
      if (color === this.project.color) swatch.addClass('pm-color-swatch--selected')
      swatch.addEventListener('click', () => {
        this.project.color = color
        colorPalette.querySelectorAll('.pm-color-swatch').forEach((s) => s.removeClass('pm-color-swatch--selected'))
        swatch.addClass('pm-color-swatch--selected')
      })
    }
    const customColor = colorPalette.createEl('input', { type: 'color', cls: 'pm-color-custom' })
    customColor.value = this.project.color
    customColor.title = 'Custom color'
    customColor.addEventListener('change', () => {
      this.project.color = customColor.value
      colorPalette.querySelectorAll('.pm-color-swatch').forEach((s) => s.removeClass('pm-color-swatch--selected'))
    })

    // ── Description ───────────────────────────────────────────────────────────
    const descSection = el.createDiv('pm-project-modal-section')
    descSection.createEl('label', { text: 'Description', cls: 'pm-label' })
    const descArea = descSection.createEl('textarea', { cls: 'pm-input pm-project-desc' })
    descArea.placeholder = 'What is this project about?'
    descArea.value = this.project.description
    descArea.addEventListener('input', () => {
      this.project.description = descArea.value
    })

    // ── Team members ──────────────────────────────────────────────────────────
    const memberSection = el.createDiv('pm-modal-section')
    memberSection.createEl('label', { text: 'Team members', cls: 'pm-label' })
    const memberWrap = memberSection.createDiv('pm-member-list')
    const renderMembers = () => {
      // Same initials as every view of this project — this list is where you'd compare
      // them, so naive two-letter initials here would contradict the board and the chart.
      const roster = projectRoster(this.project, this.plugin.settings)
      memberWrap.empty()
      for (let i = 0; i < this.project.teamMembers.length; i++) {
        const row = memberWrap.createDiv('pm-member-row')
        const name = this.project.teamMembers[i] || '?'
        new Avatar(row).setName(name, roster)
        const input = row.createEl('input', {
          type: 'text',
          value: this.project.teamMembers[i],
          cls: 'pm-input pm-member-input'
        })
        input.placeholder = 'Name'
        input.addEventListener('change', () => {
          const to = input.value.trim()
          // Tasks reference assignees by name, so two members sharing one name are a
          // single person as far as assignment goes — and picking between them in the
          // task form is a coin flip. Refuse instead of silently merging their work.
          // Compared case-insensitively: "ada" and "Ada" would be two people to every
          // lookup, which nobody means to create.
          const clash =
            to && this.project.teamMembers.some((m, j) => j !== i && m.trim().toLowerCase() === to.toLowerCase())
          if (clash) {
            new Notice(`"${to}" is already a team member.`)
            renderMembers() // discards the edit — the input reverts to the stored name
            return
          }
          // Re-point every task assigned to them, not just the list entry — see
          // ProjectStore.renameAssignee for why the list alone isn't enough.
          const moved = this.plugin.store.renameAssignee(this.project, this.project.teamMembers[i], to)
          if (moved) new Notice(`Renamed on ${moved} task${moved === 1 ? '' : 's'}.`)
          renderMembers()
        })
        const rm = row.createEl('button', { text: '✕', cls: 'pm-settings-del' })
        rm.addEventListener('click', () => {
          this.project.teamMembers.splice(i, 1)
          renderMembers()
        })
      }
      const addBtn = memberWrap.createEl('button', {
        text: '+ add member',
        cls: 'pm-prop-add-btn'
      })
      addBtn.addEventListener('click', () => {
        this.project.teamMembers.push('')
        renderMembers()
        window.setTimeout(() => {
          const inputs = memberWrap.querySelectorAll('input')
          inputs[inputs.length - 1]?.focus()
        }, 50)
      })
    }
    renderMembers()

    // ── Custom fields ─────────────────────────────────────────────────────────
    const cfSection = el.createDiv('pm-modal-section')
    const cfHeader = cfSection.createDiv('pm-modal-section-header')
    cfHeader.createSpan({ text: 'Custom fields', cls: 'pm-modal-subheading' })
    cfHeader.createSpan({ text: 'Extra properties for tasks', cls: 'pm-modal-hint' })

    const cfList = cfSection.createDiv('pm-cf-list')
    const renderCFs = () => {
      cfList.empty()
      for (let i = 0; i < this.project.customFields.length; i++) {
        this.renderCustomFieldEditor(cfList, this.project.customFields[i], i, renderCFs)
      }
      const addCFBtn = cfList.createEl('button', {
        text: '+ add custom field',
        cls: 'pm-prop-add-btn'
      })
      addCFBtn.addEventListener('click', () => {
        this.project.customFields.push({
          id: makeId(),
          name: 'New Field',
          type: 'text',
          options: []
        })
        renderCFs()
      })
    }
    renderCFs()

    // ── Footer ────────────────────────────────────────────────────────────────
    // Existing projects auto-persist on close (no Save button); new projects need
    // an explicit create step.
    const footer = el.createDiv('pm-modal-footer')
    footer.createDiv('pm-footer-spacer')

    if (this.isNew) {
      new ButtonComponent(footer).setButtonText('Cancel').onClick(() => this.close())
      new ButtonComponent(footer)
        .setButtonText('Create project')
        .setCta()
        .onClick(
          safeAsync(async () => {
            const title = titleInput.value.trim()
            if (!title) {
              titleInput.addClass('pm-input-error')
              titleInput.focus()
              return
            }
            this.project.title = title
            this.project.filePath = `${this.plugin.settings.projectsFolder}/${title.replace(/[\\/:*?"<>|]/g, '-')}.md`
            await this.plugin.store.ensureFolder(this.plugin.settings.projectsFolder)
            await this.persist()
            this.close()
          })
        )
    } else {
      new ButtonComponent(footer)
        .setButtonText('Done')
        .setCta()
        .onClick(() => this.close())
    }
  }

  private renderCustomFieldEditor(
    container: HTMLElement,
    cf: CustomFieldDef,
    index: number,
    rerender: () => void
  ): void {
    const row = container.createDiv('pm-cf-row')

    const nameInput = row.createEl('input', {
      type: 'text',
      value: cf.name,
      cls: 'pm-input pm-cf-name'
    })
    nameInput.placeholder = 'Field name'
    nameInput.addEventListener('change', () => {
      this.project.customFields[index].name = nameInput.value
    })

    const typeSelect = row.createEl('select', { cls: 'pm-input pm-select pm-cf-type' })
    const types: [CustomFieldDef['type'], string][] = [
      ['text', 'Text'],
      ['number', 'Number'],
      ['date', 'Date'],
      ['select', 'Select'],
      ['multiselect', 'Multi-select'],
      ['person', 'Person'],
      ['checkbox', 'Checkbox'],
      ['url', 'URL']
    ]
    for (const [val, label] of types) {
      const opt = typeSelect.createEl('option', { value: val, text: label })
      if (val === cf.type) opt.selected = true
    }
    typeSelect.addEventListener('change', () => {
      this.project.customFields[index].type = typeSelect.value as CustomFieldDef['type']
      rerender()
    })

    const rmBtn = row.createEl('button', { text: '✕', cls: 'pm-settings-del' })
    rmBtn.addEventListener('click', () => {
      this.project.customFields.splice(index, 1)
      rerender()
    })

    if (cf.type === 'select' || cf.type === 'multiselect') {
      const optionsWrap = row.createDiv('pm-cf-options')
      const opts = cf.options ?? []
      const renderOpts = () => {
        optionsWrap.empty()
        for (let j = 0; j < opts.length; j++) {
          const optRow = optionsWrap.createDiv('pm-cf-opt-row')
          const optInput = optRow.createEl('input', {
            type: 'text',
            value: opts[j],
            cls: 'pm-input pm-cf-opt-input'
          })
          optInput.placeholder = `Option ${j + 1}`
          optInput.addEventListener('change', () => {
            opts[j] = optInput.value
            cf.options = opts
          })
          const rmOptBtn = optRow.createEl('button', { text: '✕', cls: 'pm-settings-del' })
          rmOptBtn.addEventListener('click', () => {
            opts.splice(j, 1)
            cf.options = opts
            renderOpts()
          })
        }
        const addOptBtn = optionsWrap.createEl('button', {
          text: '+ option',
          cls: 'pm-prop-add-btn pm-prop-add-btn--sm'
        })
        addOptBtn.addEventListener('click', () => {
          opts.push('')
          cf.options = opts
          renderOpts()
        })
      }
      renderOpts()
    }
  }
}
