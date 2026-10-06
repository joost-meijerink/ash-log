/**
 * This script is a re-implementation of Fandom's interactive maps.
 * ======
 * How it works:
 * - [[Module:Map]] loads the JSON data from a wiki page and inserts it into the DOM
 * - This JS script uses that data and initialises Leaflet
 * ======
 * @author [[User:Jayden]]
 */
 
function escapeHtml(unsafe) {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

(function() {
	const getImageUrl = (filename) => {
		let base = window.location.origin;
		filename = filename.replace(/ /g, "_");
		filename = filename.replace(/\(/g, '%28').replace(/\)/g, '%29');
		let cb = '48781';
		return base + '/images/' + filename + '?' + cb;
	};

	const buildLeafletIcon = (filename, size = [25, 25]) => {
		return L.icon({
			iconSize: size,
			iconUrl: getImageUrl(filename)
		});
	};

	const createMarker = (map, cats, coordOrder, markerData, container, index) => {
		try {
			if (coordOrder === 'xy') {
				markerData.position.reverse();
			}

			let marker = L.marker(markerData.position);
			let popup = markerData.popup;

			if (popup && Object.keys(popup).length) {
				// If the marker has a popup, start building it
				let popupWrapper = $('<div>').addClass('map-popup');

				// [[Module:Map]] adds hidden elements to the DOM with the popup content, in a deterministic order
				let content = $(container).find('.map-popup').eq(index);
				if (content && content.length) {
					let children = content.children();
					if (children[0]) {
						popupWrapper.append(
							$('<h3>')
								.addClass('map-popup-title')
								.css('color', 'black')
								.html(children[0].innerHTML)
						);
					}
					if (children[1]) {
						popupWrapper.append(
							$('<span>')
								.addClass('map-popup-description')
								.html(children[1].innerHTML)
						);
					}
				}

				// If there is a link, add the URL and label
				if (popup.link) {
					popupWrapper.append(
						$('<p>').addClass('map-popup-link').append(
							$('<a>')
								.attr('href', popup.link.url)
								.text(popup.link.label)
						)
					);
				}

				marker.bindPopup(popupWrapper.get(0)).openPopup();
			}

			// Per-marker icon takes priority over category icon
			if (markerData.icon && markerData.icon.length > 0) {
				let size = [25, 25];

				if (Array.isArray(markerData.iconSize) && markerData.iconSize.length === 2) {
					size = markerData.iconSize;
				}
				
				marker.setIcon(buildLeafletIcon(markerData.icon, size));
			} else if (markerData.hasOwnProperty('categoryId')) {
				let cat = cats[markerData.categoryId];
				if (cat && cat.icon) {
					marker.setIcon(cat.icon);
				}
			}

			// Add marker to category layer if it has a category
			if (markerData.hasOwnProperty('categoryId')) {
				let cat = cats[markerData.categoryId];
				if (cat) {
					marker.addTo(cat.layerGroup);
				} else {
					marker.addTo(map);
				}
			} else {
				// The marker has no category, so just add it to the map
				marker.addTo(map);
			}

		} catch (e) {
			// If there is any error, just don't add the marker
			console.warn('Not adding marker to map due to error', e);
		}
	};

	const createLeafletMap = (c) => {
		let data = $(c).data('json') || {};

		// used to alter the map to the correct view, given it was originally based on an earlier map (pre-fellhollow)
		// so x=0 is west of the starting temple, and y=0 is north of the stormtouched highlands
		// map of 2026-06-25 inset the existing map by a little so there's more visible ocean, so we also have a fixed offset
		// mult is used to scale coordinates appropriately: (pixel size of the map) / (unit size of the map) / (tiles of the original map = 16)
		const mult = 6144 / 420000 / 16,
					offset_x = 11075,
					offset_y = 100800 + 16885;
		
		// lon => x values
		// lat => y values
		// top-left, bottom-right
		let bounds = [{ lon: -offset_x, lat: -offset_y }, { lon: 420000-offset_x, lat: 420000-offset_y }];

		let dragonwildsCRS = L.extend({}, L.CRS.Simple, {
			projection: L.Projection.LonLat,
			transformation: new L.Transformation(mult, mult * offset_x, mult, mult * offset_y)
		});

		let map = L.map(c, {
			crs: dragonwildsCRS,
			maxBounds: bounds,
			zoom: data.zoom || 2,
			minZoom: 0.5,
			maxZoom: 4,
			zoomSnap: 0.5,
			attributionControl: false,
			fullscreenControl: true
		});

		const baseLayer = L.tileLayer('https://maps.runescape.wiki/dw/tiles/{z}/{x}_{y}.png');
		baseLayer.addTo(map);

		if (data.center) {
			map.panTo(data.center);
		} else {
			map.fitBounds(bounds);
		}
		
		new ResizeObserver(() => {
			map.invalidateSize();
		}).observe(c);
		
		map.on('click', function(e) {
			console.log("Clicked at " + e.latlng);
		});

		// If there are any categories, add them to a key-value object for faster lookups
		let categories = {};
		if (data.hasOwnProperty('categories')) {
			for (let c of data.categories) {
				let newCat = {
					id: c.id || '',
					name: escapeHtml(c.name) || ''
				};

				if (c.icon) {
					// If there is an icon for this category, create a Leaflet icon
					newCat.icon = buildLeafletIcon(c.icon);
				} else {
					// Else, use a default marker with a specific colour
					const icon = {
						mapIconUrl: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 31" height="26px" width="20.129032258064516px"><path class="marker" stroke="#fff" stroke-width="2" fill-rule="evenodd" clip-rule="evenodd" d="M17.91 20.1A9.99 9.99 0 0012 2.03 10 10 0 006.09 20.1c1.88 1.42 4.53 3.65 5.14 7.25a.8.8 0 00.77.68c.39 0 .7-.3.77-.68.61-3.6 3.26-5.83 5.14-7.25z" fill="{mapIconColor}"></path><circle class="marker-circle" cx="12" cy="12" r="4" fill="#0E191A" fill-opacity=".5"></circle><text font-size="12px" y="50%" x="50%" text-anchor="middle" fill="{markerColor}" font-weight="bold">{marker}</text></svg>',
						mapIconColor: escapeHtml(c.color) || '46accf',
						marker: escapeHtml(c.symbol) || '',
						markerColor: escapeHtml(c.symbolColor) || '#fff'
					};

					newCat.icon = L.divIcon({
						className: 'map-default-marker',
						html: L.Util.template(icon.mapIconUrl, icon)
					});
				}

				// Make a LayerGroup for this category
				newCat.layerGroup = L.layerGroup();
				newCat.layerGroup.addTo(map);

				categories[c.id] = newCat;
			}
		}

		// Create markers, if there are any
		if (data.hasOwnProperty('markers')) {
			for (let ix in data.markers) {
				createMarker(map, categories, data.coordinateOrder || 'xy', data.markers[ix], c, ix);
			}
		}

		// Unlike Fandom, support configuring some specific settings directly
		let settings = $(c).data('settings') || {};
		if (settings.visibleCategories !== undefined) {
			let visibleCats = settings.visibleCategories;
			for (let cat of Object.values(categories)) {
				if (!visibleCats.includes(cat.id) || visibleCats.length === 0 || visibleCats.includes('None')) {
					// Remove any marker categories that aren't supposed to be displayed by default
					map.removeLayer(cat.layerGroup);
				}
			}
		}

		// Add a control to change the layers on the map
		L.control.layers(
			{ 'Base': baseLayer },
			Object.assign({}, ...Object.values(categories).map((c) => {
				return { [c.name]: c.layerGroup };
			})),
			{
				hideSingleBase: true
			}
		).addTo(map);
	};

	// Load Leaflet's CSS
	mw.loader.load('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css', 'text/css');
	mw.loader.load('https://cdnjs.cloudflare.com/ajax/libs/leaflet.fullscreen/3.0.2/Control.FullScreen.min.css', 'text/css');

	// Load Leaflet's JS
	mw.loader.getScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js').then(
		function() {
			// These plugins rely on Leaflet being loaded first. If we load them at the same time, it can cause a race condition.
			mw.loader.getScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet.fullscreen/3.0.2/Control.FullScreen.min.js').then(
				function() {
					try {
						let containers = $('.map');

						containers.each((i, c) => {
							createLeafletMap(c);
						});

						// When we're done creating the maps, remove any unnecessary hanging DOM nodes
						$('.map-popup').remove();

					} catch (e) {
						mw.log.error(e);
					}
				}
			);
		},
		function(e) {
			mw.log.error(e.message);
		}
	);
})();