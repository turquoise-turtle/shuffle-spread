//https://stackoverflow.com/a/5767357/
function removeItemAll(arr, value) {
	var i = 0;
	while (i < arr.length) {
		if (arr[i] === value) {
			arr.splice(i, 1);
		} else {
			++i;
		}
	}
	//return arr;
}
//https://30secondsofcode.org/object#deepclone
const deepClone = obj => {
	let clone = Object.assign({}, obj);
	Object.keys(clone).forEach(
		key => (clone[key] = typeof obj[key] === 'object' ? deepClone(obj[key]) : obj[key])
	);
	return Array.isArray(obj) && obj.length
		? (clone.length = obj.length) && Array.from(clone)
		: Array.isArray(obj)
			? Array.from(obj)
			: clone;
};
//https://stackoverflow.com/a/1527820/
function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
//based off of https://davidwalsh.name/fill-array-javascript
var fillRange = function fillRange(character, length) {
	return Array(length).fill().map(function (item, index) {
		return character + (index + 1);
	});
};









var lists = [
	//['A1', 'A2', 'A3', 'A4'],
	//['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'],
	//['C1', 'C2', 'C3', 'C4', 'C5'],
	//['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12'],
	//['E1', 'E2', 'E3']
];

function a(word, length) {
	// console.log(length);
	lists.push(fillRange(word, length));	
}
//lists.push(fillRange('F', 10))
//lists.push(fillRange('G', 5))

// a('ninetyninepi', '40');
// a('planet', '40');
// a('etiq', 40);
// a('reply', 13);
// a('hamish', 41)
// a('bible', 60);
// a('background', 27)
// a('church', 29)
// a('aom', 50);
// a('opendoors', 33)
// a('probs', 39)
// a('law', 40)
// a('hertz', 20)
// a('gcf', 15)
// a('monday', 17)
// a('script', 20)
// a('dark', 50)
// a('casefile', 50)
// a('jfh', 30)
// a('moment', 6)
// a('mastery', 55)
// a('longreads', 29)
// a('sophia', 50)
// a('timeline', 25)
// a('punch', 99)
// a('conversations', 99)
// a('hamilcast', 99)
// a('pants', 5)
// a('made', 14)
// a('hatemovies', 99)
// a('offbook', 30)
// a('empty', 6)

function maxlength(nestedlists) {
	var max = 0;
	for (var list of nestedlists) {
		if (list.length > max) {
			max = list.length;
		}
	}
	//console.log(max);
	return max;
}

function fillwithdummies(nestedlists) {
	var l = maxlength(nestedlists);
	for (var list of nestedlists) {
		var m = list.length;
		if (m < l) {
			//console.log(l - m, m/(l-m));
			var needed = l - m;
			if (m / (l-m) >= 1) {
				var flooreddivlength = Math.floor(m / (l-m));
			} else {
				var flooreddivlength = m / (l-m);
			}
			
			console.log('m', m, 'needed', needed, 'm/(l-m)', m/(l-m), 'floored=', flooreddivlength) //doesn't work ->, 'l/m', l/m, 'l/needed', l/needed);
			
			var curposition = 0 + flooreddivlength;
			//var curposition = 1;

			while (needed > 0) {
				//console.log(curposition);
				list.splice(curposition, 0, 'Z');
				curposition = curposition + 1 + flooreddivlength;
				needed = needed - 1;
			}
			console.log(list);
		}
		listtotable('#table1', list)
	}
}

function listtotable(sel, items) {
	//var row = document.createElement('tr');
	for (var item of items) {
		var row = document.createElement('tr');
		possibleTitle = item;
		var regex = /[a-zA-Z]*/;
    	var numberString = possibleTitle.match(regex)[0];
		//console.log(item, numberString);
		row.classList.add(numberString);
		

		var cell = document.createElement('td');
		cell.innerText = item;
		row.appendChild(cell);

		document.querySelector(sel).appendChild(row);
	}
	//document.querySelector(sel).appendChild(row);
}

function consolidatelists(nestedlists) {
	var l = maxlength(nestedlists);
	var n = nestedlists.length;
	var ult = [];

	//basic top to bottom consolidation
	///*
	for (var i=0; i<l; i++) {
		for (var j=0; j<n; j++) {
			ult.push(nestedlists[j][i]);
		}
	}
	//*/

	//random consolidation
	/*
	var mini = [];
	for (var j=0; j<n; j++) {
		mini.push(j);
	}
	for (var i=0; i<l; i++) {
		var mj = deepClone(mini);
		
		for (var j=0; j<n; j++) {
			var rowindex = getRandomInt(0, mj.length - 1);
			var row = mj[rowindex];
			mj.splice(rowindex, 1);
			ult.push(nestedlists[row][i]);
		}
	}
	//*/
		

	console.log(ult);
	listtotable('#table2', ult);
	removeItemAll(ult, 'Z');
	listtotable('#table3', ult);
}


document.querySelector('#add').addEventListener('click', function() {
	var name = document.querySelector('#name').value;
	var number = document.querySelector('#number').value;
	if (name !== 'end' && name !== '') {
		number = parseFloat(number);
		// console.log(number, typeof number);
		a(name, number);
		document.querySelector('#name').value = '';
		document.querySelector('#number').value = '';
	} else {
		fillwithdummies(lists);
		consolidatelists(lists);
		lists = [];
	}
})


// fillwithdummies(lists);
// consolidatelists(lists);


var myEles = document.getElementsByTagName('td');
for(var i=0; i<myEles.length; i++){
    if(myEles[i].innerText == 'Z'){
         //console.log('gotcha'); 

         //use javascript to style
         myEles[i].setAttribute('class', "gotcha");
    }
}