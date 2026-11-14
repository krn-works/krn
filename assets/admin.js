(function(){
	document.addEventListener('DOMContentLoaded', function(){
		// Collapsible language block (click caret or header)
		document.addEventListener('click', function(e){
			var header = e.target.closest('.asl-caret, .asl-collapsible-header');
			if(!header) return;
			var card = header.closest('.asl-collapsible');
			if(!card) return;
			var body = card.querySelector('.asl-collapsible-body');
			if(!body) return;
			if(card.classList.contains('collapsed')){
				card.classList.remove('collapsed');
				body.style.display = 'block';
			}else{
				body.style.display = 'none';
				card.classList.add('collapsed');
			}
		}, false);

		// Language tabs filtering
		document.addEventListener('click', function(e){
			var tab = e.target.closest('.asl-tab');
			if(!tab) return;
			var lang = tab.getAttribute('data-lang');
			var tabs = tab.parentElement.querySelectorAll('.asl-tab');
			tabs.forEach(function(t){ t.classList.toggle('active', t === tab); });
			var card = tab.closest('.asl-collapsible');
			var tbody = card.querySelector('tbody');
			var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
			var shown = 0; rows.forEach(function(tr){
				var txt = (tr.querySelector('td') ? tr.querySelector('td').textContent : '').trim();
				var match = (!lang || txt === lang);
				tr.dataset.match = match ? '1' : '0';
				if (match && shown < 30) { tr.style.display = ''; shown++; } else { tr.style.display = 'none'; }
			});
		}, false);

		// Initialize: collapse cards by default (CSS) and set default active tab (first tab)
		document.querySelectorAll('.asl-tabs').forEach(function(tabs){
			var first = tabs.querySelector('.asl-tab');
			if(first){ first.click(); }
		});

		// Infinite scroll/pagination for language table
		document.querySelectorAll('.asl-collapsible .asl-scrollbox tbody').forEach(function(tbody){
			var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
			var pageSize = 30;
			rows.forEach(function(tr, i){ tr.style.display = i < pageSize ? '' : 'none'; });
			var box = tbody.closest('.asl-collapsible-body');
			box.addEventListener('scroll', function(){
				if(box.scrollTop + box.clientHeight >= box.scrollHeight - 10){
					var matched = rows.filter(function(tr){ return tr.dataset.match !== '0'; });
					var visible = matched.filter(function(tr){ return tr.style.display !== 'none'; }).length;
					matched.slice(visible, visible + pageSize).forEach(function(tr){ tr.style.display = ''; });
				}
			});
		});
	});
})();

