/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
/* exported init */
const GETTEXT_DOMAIN = 'my-indicator-extension';

const { GObject, St, Gio } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Me = ExtensionUtils.getCurrentExtension();

const {settingsDef} = Me.imports.settingsDef
const SettingsManager = Me.imports.utils.SettingsManager

let settingsManager

const Ornament = {
	NONE: 0,
	DOT: 1,
	CHECK: 2,
	HIDDEN: 3,
}

/** spwan async upower -d command an return promise of the result */
const spawnAsync = async (cmd) => new Promise((resolve, reject) => {
	try {
		let proc = Gio.Subprocess.new(
			cmd,
			Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
		)
		proc.communicate_utf8_async(null, null, (proc, res) => {
			try {
				let [, stdout, stderr] = proc.communicate_utf8_finish(res)
				if (proc.get_successful()) {
					resolve(stdout)
				} else {
					reject(stderr)
				}
			} catch (e) {
				logError(e)
			}
		});
	} catch (e) {
		logError(e)
	}
})

/** parse output of upower -d */
const upowerParser = (output) => {
	const items = String(output).split('\n\n')
		.filter(_ => {
			return _.match(/^Device:/)     // only devices
				&& _.match(/^\s*serial:/m)   // remove if no serial
		})
		.map(deviceStr => {
			const lines = deviceStr.split('\n').map(line => {
				const groups = line.match(/^\s*(?<prop>[^:]+):\s*(?<val>.*)$/)?.groups
				if (!groups)
					return {prop: 'type', val:line.trim()}
				let {prop, val} = groups
				prop = prop.replace(/[\s-]/g, '_')
				switch(prop) {
					// case 'percentage':
					// 	val = parseInt(val, 10)
					// 	break
					case 'icon_name':
						val = val.replace(/'([^']+)'/, '$1')
						break
					default:
						val = val==='no' ? false : val ==='yes' ? true : val
						break
				}
				return {prop, val}
			})
			return lines.reduce((acc,cur) => {acc[cur.prop] = cur.val; return acc}, {})
		})

	return items
}
/** return desired icon regarding upower */
const getDeviceIcon = (device) => {
	if (device.type === 'gaming-input')
		return 'input-gaming-symbolic'
	if (device.model?.match(/keyboard/i) || device.type === 'keyboard')
		return 'input-keyboard-symbolic'
	if (device.type==='mouse' || device.model?.match(/mouse/u))
		return 'input-mouse-symbolic'
	if (device.type==='tablet')
		return 'input-tablet-symbolic'
	return device.icon_name
}

const makeMenuItem = (params) => {
	const {label, icon, secondaryIcon, onActivate, ornament = Ornament.HIDDEN, labelStyle, ..._params} = params || {}
	const item = icon
		? new PopupMenu.PopupImageMenuItem(label, icon, _params||undefined)
		: new PopupMenu.PopupMenuItem(label, _params||undefined)
	item.setOrnament(ornament) // hidden Ornament
	onActivate && item.connect('activate', onActivate)
	labelStyle && item.label.set_style(labelStyle)
	secondaryIcon && item.insert_child_at_index(new St.Icon({
		icon_name:secondaryIcon,
		style_class:'popup-menu-icon'
	}), 2)
	return item
}

const Indicator = GObject.registerClass( class Indicator extends PanelMenu.Button {
	_init() {
		super._init(0.0, 'Battery indicator')

		this._indicatorsBoxLayout = new St.BoxLayout({style_class:'battery-indicator-boxlayout'})

		// add a loading icon while initializing
		this.add_child(this._indicatorsBoxLayout);
		this._indicatorsBoxLayout.add_child(new St.Icon({
			icon_name: 'emblem-synchronizing',
			style_class: 'system-status-icon',
		}))

		this.addRefreshMenuItem()
		this._refreshTimeout = null
	}

	async refreshIndicator() {
		this._refreshTimeout && clearTimeout(this._refreshTimeout)
		let stdout
		try {
			stdout = await spawnAsync(['upower', '-d'])
		} catch (e) {
			e instanceof Uint8Array && (e = BiteArray.toString(e))
			logError('Error:',e)
			throw new Error(e)
		}
		const devices = upowerParser(stdout)
		this.removeChilds()
		const container = this._indicatorsBoxLayout
		const hiddenDevices = settingsManager.get('hidden-devices')
			.filter((serial) => devices.find(d => d?.serial === serial) ? true : false)

		devices.length && devices.forEach((device, id) => {
			const {serial, model, state} = device
			const isHiddenDevice = hiddenDevices.includes(serial)
			let displayed = !isHiddenDevice
			if (id===0 && devices.length === hiddenDevices.length) {
				displayed = true // ensure one device is still visible
			}
			const reliable = !device.percentage.match(/ignored/)
			const percentage = parseInt(device.percentage, 10)+'%'
			const charging = state==='charging'
			const icon_name = getDeviceIcon(device)
			if (displayed) {
				const icon = new St.Icon({
					icon_name,
					style_class: 'system-status-icon',
					style: `margin-right:0;${
						id ? '' : 'margin-left:0px;' // remove margin for first Icon
					}${
						charging ? 'color:yellow;' : ''
					}`
				})
				const label = new St.Label({
					text: percentage,
					style_class: 'battery-indicator-label',
					style: (charging ? 'color:yellow;' : '') + (reliable ? '' : 'font-style:italic;'),
					y_align: St.Align.END
				})
				container.add_child(icon)
				container.add_child(label)
			}
			const menuItem = makeMenuItem({
				label: `${model} (${state||'unknown'}) ${percentage}`,
				icon: icon_name,
				secondaryIcon: device.icon_name,
				labelStyle: reliable ? '' : 'font-style:italic;',
				ornament: Ornament[isHiddenDevice ? 'NONE' : 'CHECK']
				,
				onActivate: () => {
					const hiddenDevices = settingsManager.get('hidden-devices').filter(s => s!==serial)
					isHiddenDevice || hiddenDevices.push(serial)
					settingsManager.set('hidden-devices', hiddenDevices)
				}
			})
			this.menu.addMenuItem(menuItem)
		})

		this._refreshTimeout = setTimeout(() => {
			this.refreshIndicator()
		}, (settingsManager.get("refresh-interval")||300) * 1000)
		settingsManager.get('refresh-menuitem') && this.addRefreshMenuItem()
	}

	removeChilds() {
		const container = this._indicatorsBoxLayout
		let child = container.get_first_child()
		while(child) {
			container.remove_child(child)
			child.destroy()
			child = container.get_first_child()
		}
		this.menu.removeAll()
	}

	addRefreshMenuItem() {
		const refreshMenuItem = makeMenuItem({
			label: 'Refresh now',
			icon: 'emblem-synchronizing-symbolic',
			onActivate: () => {
				clearTimeout(this._refreshTimeout)
				this._refreshTimeout = setTimeout(() => this.refreshIndicator(), 500)
			}
		})
		this.menu.addMenuItem(refreshMenuItem)
	}

});

class Extension {
	constructor(uuid) {
		this._uuid = uuid
		ExtensionUtils.initTranslations(GETTEXT_DOMAIN)
	}

	enable() {
		const indicator = new Indicator()
		this._indicator = indicator
		settingsManager = SettingsManager.init(
			'org.gnome.shell.extensions.battery-indicator-upower',
			settingsDef
		)._startListening()
		indicator.refreshIndicator()
		this._settingObserver = settingsManager.addChangeObserver(() => {
			indicator.refreshIndicator()
		})
		Main.panel.addToStatusArea(this._uuid, this._indicator)
	}

	disable() {
		if (this._settingObserver){
			this._settingObserver?.()
			this._settingObserver = null
		}
		this._indicator?.destroy()
		settingsManager = settingsManager.destroy()
		clearTimeout(this._indicator?._refreshTimeout)
		this._indicator = null
	}

}

function init(meta) {
	return new Extension(meta.uuid)
}
